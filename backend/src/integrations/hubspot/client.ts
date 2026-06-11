/**
 * HubSpot REST client (M5.T2).
 *
 * Thin wrapper over the HubSpot V3 CRM REST API. Speaks JSON, knows nothing
 * about BullMQ / drizzle / lead semantics — those live in `dual-write.ts`.
 *
 * Auth: HubSpot Service Keys + Private App tokens share the same shape:
 *   `Authorization: Bearer <token>`. We never read the env directly here;
 *   the token is passed in via constructor so tests can swap it.
 *
 * PII discipline:
 *   - The token is NEVER logged. Only the HTTP method + path + status code
 *     surface to logs.
 *   - On error, we surface `status + short prefix of HubSpot's response
 *     body (≤200 chars)`. HubSpot's error JSON normally echoes field names +
 *     error codes, not values — but the truncation is the safety net.
 *   - We never echo the REQUEST body (contains email/phone/name) into errors
 *     or log lines.
 *
 * Retry:
 *   - 429 + 5xx are retryable. 3 attempts total, exponential backoff (1s,2s,4s).
 *   - 4xx other than 429 surface immediately — the caller (dual-write) gets a
 *     chance to detect "property does not exist" and degrade.
 *
 * Pipeline discovery:
 *   - Every portal has a default deal pipeline. If callers don't supply
 *     `HUBSPOT_PIPELINE_ID` + `HUBSPOT_NEW_DEAL_STAGE`, we hit
 *     `GET /crm/v3/pipelines/deals` ONCE per process and cache.
 */
import { logger } from '../../logger.js';

const DEFAULT_BASE_URL = 'https://api.hubapi.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1_000;
/** HubSpot's error bodies are usually small JSON; cap to keep logs PII-safe. */
const ERROR_BODY_PREFIX_LEN = 200;

export interface HubSpotClientOptions {
  accessToken: string;
  /** Default https://api.hubapi.com — overridden for the test stub server. */
  baseUrl?: string;
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for retry sleep — tests set this to 0 to skip real waiting. */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface UpsertContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  /** E.164 preferred. */
  phone?: string;
  /** Free-form custom properties — HubSpot's snake_case property names. */
  properties?: Record<string, string>;
}

export interface UpsertContactOutput {
  hubspotContactId: string;
  isNew: boolean;
}

export interface CreateDealInput {
  dealName: string;
  amount?: number;
  /** Pipeline ID; defaults to discovered default when omitted. */
  pipeline?: string;
  /** Stage ID. */
  dealStage?: string;
  /** Passes through to the `product_line` custom property if it exists. */
  productLine?: 'scooter' | 'car';
  properties?: Record<string, string | number>;
}

export interface CreateDealOutput {
  hubspotDealId: string;
}

export interface DefaultPipelineAndStage {
  pipelineId: string;
  newDealStageId: string;
}

interface HubSpotErrorBody {
  status?: string;
  message?: string;
  category?: string;
  errors?: Array<{ message?: string; in?: string }>;
}

/**
 * Custom error subclass — lets dual-write.ts detect "property does not exist"
 * and retry without those properties. Carries the HubSpot status + a short
 * body prefix (PII-safe), the raw error code, and the property name HubSpot
 * complained about (when extractable).
 */
export class HubSpotApiError extends Error {
  readonly status: number;
  readonly bodyPrefix: string;
  readonly code: string | null;
  readonly missingProperty: string | null;

  constructor(opts: {
    method: string;
    path: string;
    status: number;
    body: string;
    code?: string | null;
    missingProperty?: string | null;
  }) {
    const prefix = opts.body.slice(0, ERROR_BODY_PREFIX_LEN);
    super(`HubSpot ${opts.method} ${opts.path} -> ${opts.status}: ${prefix}`);
    this.name = 'HubSpotApiError';
    this.status = opts.status;
    this.bodyPrefix = prefix;
    this.code = opts.code ?? null;
    this.missingProperty = opts.missingProperty ?? null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the HubSpot v3 associations array for object-create calls.
 * Each entry references a "to" object by id and applies the given
 * HUBSPOT_DEFINED association typeId.
 *
 * Shape expected by POST /crm/v3/objects/<type>:
 *   associations: [{
 *     to: { id: "<objectId>" },
 *     types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: <n> }]
 *   }]
 */
function buildAssociations(links: Array<{ toId: string; typeId: number }>): Array<{
  to: { id: string };
  types: Array<{ associationCategory: string; associationTypeId: number }>;
}> {
  return links.map(({ toId, typeId }) => ({
    to: { id: toId },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
  }));
}

export class HubSpotClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Per-instance pipeline cache. */
  private pipelineCache: DefaultPipelineAndStage | null = null;

  constructor(opts: HubSpotClientOptions) {
    if (!opts.accessToken) {
      throw new Error('HubSpotClient: accessToken is required');
    }
    this.token = opts.accessToken;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep =
      opts.sleepMs ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Idempotent upsert by email. Uses HubSpot's batch upsert endpoint with
   * `idProperty=email`, which:
   *   - creates a new contact when none has that email,
   *   - merges into the existing contact otherwise,
   *   - returns `new: true` when the row was just created.
   *
   * This is the right primitive for V1 because we receive leads from multiple
   * sources (website, Meta, organic). A returning visitor on a different
   * channel must not duplicate the HubSpot contact.
   */
  async upsertContact(input: UpsertContactInput): Promise<UpsertContactOutput> {
    const properties: Record<string, string> = {
      email: input.email,
      ...(input.firstName ? { firstname: input.firstName } : {}),
      ...(input.lastName ? { lastname: input.lastName } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.properties ?? {}),
    };

    const body = {
      inputs: [
        {
          idProperty: 'email',
          id: input.email,
          properties,
        },
      ],
    };

    const json = await this.request<{
      results?: Array<{ id?: string; new?: boolean }>;
    }>('POST', '/crm/v3/objects/contacts/batch/upsert', body);

    const first = json.results?.[0];
    if (!first?.id) {
      throw new Error('HubSpot upsertContact: no result id in response');
    }
    return {
      hubspotContactId: first.id,
      isNew: Boolean(first.new),
    };
  }

  async createDeal(input: CreateDealInput): Promise<CreateDealOutput> {
    const properties: Record<string, string | number> = {
      dealname: input.dealName,
      ...(typeof input.amount === 'number' ? { amount: input.amount } : {}),
      ...(input.pipeline ? { pipeline: input.pipeline } : {}),
      ...(input.dealStage ? { dealstage: input.dealStage } : {}),
      ...(input.productLine ? { product_line: input.productLine } : {}),
      ...(input.properties ?? {}),
    };

    const json = await this.request<{ id?: string }>('POST', '/crm/v3/objects/deals', {
      properties,
    });
    if (!json.id) {
      throw new Error('HubSpot createDeal: no id in response');
    }
    return { hubspotDealId: json.id };
  }

  /**
   * Associate a contact with a deal using the HubSpot **V4** default
   * association endpoint. The old V3 `/associations/default/deals/{id}` path
   * was retired and now 400s with "Unable to infer object type from: default";
   * V4 `/crm/v4/objects/{from}/{id}/associations/default/{to}/{id}` applies the
   * system default (primary) association label between the two objects.
   */
  async associateContactDeal(contactId: string, dealId: string): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}` +
        `/associations/default/deals/${encodeURIComponent(dealId)}`,
      null,
    );
  }

  /**
   * Resolve the default deal pipeline + the first stage in it (the "new" stage).
   * Cached for the life of this client instance — pipelines rarely change.
   */
  async getDefaultDealPipelineAndStage(): Promise<DefaultPipelineAndStage> {
    if (this.pipelineCache) return this.pipelineCache;

    const json = await this.request<{
      results?: Array<{
        id: string;
        label?: string;
        displayOrder?: number;
        stages?: Array<{ id: string; label?: string; displayOrder?: number }>;
      }>;
    }>('GET', '/crm/v3/pipelines/deals', null);

    const pipelines = json.results ?? [];
    if (pipelines.length === 0) {
      throw new Error('HubSpot getDefaultDealPipelineAndStage: no pipelines returned');
    }
    // Pick the lowest displayOrder (== the "default" in HubSpot UI ordering).
    const sortedPipelines = [...pipelines].sort(
      (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
    );
    const pipeline = sortedPipelines[0];
    if (!pipeline) {
      // Already guarded by pipelines.length above; defensive duplicate so the
      // narrowed type carries through without a non-null assertion.
      throw new Error('HubSpot getDefaultDealPipelineAndStage: no pipelines returned');
    }
    const stages = pipeline.stages ?? [];
    if (stages.length === 0) {
      throw new Error(
        `HubSpot getDefaultDealPipelineAndStage: pipeline ${pipeline.id} has no stages`,
      );
    }
    const sortedStages = [...stages].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
    const firstStage = sortedStages[0];
    if (!firstStage) {
      throw new Error(
        `HubSpot getDefaultDealPipelineAndStage: pipeline ${pipeline.id} has no stages`,
      );
    }

    this.pipelineCache = {
      pipelineId: pipeline.id,
      newDealStageId: firstStage.id,
    };
    return this.pipelineCache;
  }

  /**
   * Cheap health probe — fetches one contact. Returns `{healthy:true}` on any
   * 2xx, `{healthy:false}` otherwise. Connection errors (ECONNREFUSED, DNS,
   * timeouts) surface as `healthy:false` with a short detail.
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await this.rawRequest('GET', '/crm/v3/objects/contacts?limit=1', null);
      return { healthy: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
      return { healthy: false, detail };
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1 additions — property management, pipeline management, updates
  // ---------------------------------------------------------------------------

  /** Idempotently ensure a custom property exists on an object type. */
  async ensureProperty(
    objectType: 'contacts' | 'deals',
    prop: {
      name: string;
      label: string;
      type: 'string' | 'number' | 'enumeration';
      groupName: string;
      options?: Array<{ label: string; value: string }>;
    },
  ): Promise<void> {
    try {
      await this.request<unknown>(
        'GET',
        `/crm/v3/properties/${objectType}/${encodeURIComponent(prop.name)}`,
        null,
      );
      return; // already exists
    } catch (err) {
      if (!(err instanceof HubSpotApiError) || err.status !== 404) throw err;
    }
    const fieldType =
      prop.type === 'number' ? 'number' : prop.type === 'enumeration' ? 'select' : 'text';
    const body: Record<string, unknown> = {
      name: prop.name,
      label: prop.label,
      type: prop.type,
      fieldType,
      groupName: prop.groupName,
    };
    if (prop.options) body.options = prop.options;
    try {
      await this.request<unknown>('POST', `/crm/v3/properties/${objectType}`, body);
    } catch (err) {
      // A concurrent create (or pre-existing) → treat "already exists" as success.
      if (
        err instanceof HubSpotApiError &&
        (err.status === 409 || /already exists/i.test(err.message))
      )
        return;
      throw err;
    }
  }

  /** List all deal pipelines. */
  async listPipelines(): Promise<
    Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }>
  > {
    const json = await this.request<{
      results?: Array<{
        id: string;
        label: string;
        stages?: Array<{ id: string; label: string }>;
      }>;
    }>('GET', '/crm/v3/pipelines/deals', null);
    return (json.results ?? []).map((p) => ({
      id: p.id,
      label: p.label,
      stages: p.stages ?? [],
    }));
  }

  /** Create a deal pipeline with the given stages. Returns the created pipeline. */
  async createPipeline(
    label: string,
    stages: Array<{
      label: string;
      displayOrder: number;
      metadata: Record<string, string>;
    }>,
  ): Promise<{ id: string; stages: Array<{ id: string; label: string }> }> {
    const json = await this.request<{
      id?: string;
      stages?: Array<{ id: string; label: string }>;
    }>('POST', '/crm/v3/pipelines/deals', { label, displayOrder: 99, stages });
    if (!json.id) throw new Error('HubSpot createPipeline: no id in response');
    return { id: json.id, stages: json.stages ?? [] };
  }

  /** Replace a deal pipeline's label + stages (free tier: we adopt the single existing pipeline). */
  async updatePipeline(
    pipelineId: string,
    label: string,
    stages: Array<{ label: string; displayOrder: number; metadata: Record<string, string> }>,
  ): Promise<{ id: string; stages: Array<{ id: string; label: string }> }> {
    const json = await this.request<{
      id?: string;
      stages?: Array<{ id: string; label: string }>;
    }>('PUT', `/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`, {
      label,
      displayOrder: 0,
      stages,
    });
    if (!json.id) throw new Error('HubSpot updatePipeline: no id in response');
    return { id: json.id, stages: json.stages ?? [] };
  }

  /** PATCH deal properties. */
  async updateDeal(dealId: string, properties: Record<string, string | number>): Promise<void> {
    await this.request<unknown>('PATCH', `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      properties,
    });
  }

  /** PATCH contact properties. */
  async updateContact(contactId: string, properties: Record<string, string>): Promise<void> {
    await this.request<unknown>(
      'PATCH',
      `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { properties },
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 3 — Activity timeline engagements
  //
  // All three methods use the HubSpot v3 CRM objects API.
  // Docs: https://developers.hubspot.com/docs/api/crm/engagements
  //
  // Association typeIds (HUBSPOT_DEFINED category):
  //   Notes  → contact: 202,  deal: 214
  //   Calls  → contact: 194,  deal: 206
  //   Comms  → contact: 82,   deal: 86
  //
  // These are the HubSpot-standard (built-in) association type IDs from the
  // public docs. If live-verify finds a mismatch, check:
  //   GET /crm/v4/associations/{fromObjectType}/{toObjectType}/labels
  //
  // PII note: activity BODIES contain message text — that is the point of
  // the timeline. We NEVER log the body content; only ids + booleans surface
  // to our logger.
  // ---------------------------------------------------------------------------

  /**
   * Create a HubSpot Note engagement and associate it to a contact + deal.
   *
   * Endpoint: POST /crm/v3/objects/notes
   * Properties:
   *   hs_note_body  — plain-text note content (may contain transcript summary)
   *   hs_timestamp  — ISO-8601 / milliseconds epoch (both accepted by HubSpot)
   * Associations:
   *   contact typeId 202 (HUBSPOT_DEFINED), deal typeId 214 (HUBSPOT_DEFINED)
   */
  async createNote(input: {
    body: string;
    contactId: string;
    dealId: string;
    timestamp: Date;
  }): Promise<{ noteId: string }> {
    const associations = buildAssociations([
      { toId: input.contactId, typeId: 202 },
      { toId: input.dealId, typeId: 214 },
    ]);
    const json = await this.request<{ id?: string }>('POST', '/crm/v3/objects/notes', {
      properties: {
        hs_note_body: input.body,
        hs_timestamp: input.timestamp.toISOString(),
      },
      associations,
    });
    if (!json.id) throw new Error('HubSpot createNote: no id in response');
    logger.debug({ noteId: json.id }, 'hubspot: note created');
    return { noteId: json.id };
  }

  /**
   * Create a HubSpot Call engagement and associate it to a contact + deal.
   *
   * Endpoint: POST /crm/v3/objects/calls
   * Properties:
   *   hs_call_title     — short label shown in the timeline header
   *   hs_call_body      — transcript summary or notes (never logged on our end)
   *   hs_timestamp      — ISO-8601 datetime
   *   hs_call_status    — COMPLETED (we only log calls that already happened);
   *                       HubSpot 400s without it.
   *   hs_call_duration  — optional, milliseconds. HubSpot v3 expects a STRING of
   *                       milliseconds, so we String()-ify it; omitted when no
   *                       finite duration is provided.
   *   hs_call_direction — OUTBOUND (we always originate calls)
   * Associations:
   *   contact typeId 194 (HUBSPOT_DEFINED), deal typeId 206 (HUBSPOT_DEFINED)
   */
  async createCall(input: {
    title: string;
    body: string;
    durationMs?: number;
    contactId: string;
    dealId: string;
    timestamp: Date;
  }): Promise<{ callId: string }> {
    const properties: Record<string, string | number> = {
      hs_call_title: input.title,
      hs_call_body: input.body,
      hs_timestamp: input.timestamp.toISOString(),
      hs_call_direction: 'OUTBOUND',
      hs_call_status: 'COMPLETED',
    };
    if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) {
      properties.hs_call_duration = String(input.durationMs);
    }
    const associations = buildAssociations([
      { toId: input.contactId, typeId: 194 },
      { toId: input.dealId, typeId: 206 },
    ]);
    const json = await this.request<{ id?: string }>('POST', '/crm/v3/objects/calls', {
      properties,
      associations,
    });
    if (!json.id) throw new Error('HubSpot createCall: no id in response');
    logger.debug({ callId: json.id }, 'hubspot: call engagement created');
    return { callId: json.id };
  }

  /**
   * Create a HubSpot Communication engagement (WhatsApp / SMS) and associate
   * it to a contact + deal.
   *
   * Endpoint: POST /crm/v3/objects/communications
   * Properties:
   *   hs_communication_channel_type — WHATSAPP | SMS
   *   hs_communication_body         — message body (never logged on our end)
   *   hs_communication_logged_from  — CRM (required by HubSpot)
   *   hs_timestamp                  — ISO-8601 datetime
   * Associations:
   *   contact typeId 82 (HUBSPOT_DEFINED), deal typeId 86 (HUBSPOT_DEFINED)
   *
   * Requires scope: crm.objects.communications.write (not yet on Service Key).
   */
  async createCommunication(input: {
    channel: 'WHATSAPP' | 'SMS';
    body: string;
    contactId: string;
    dealId: string;
    timestamp: Date;
  }): Promise<{ communicationId: string }> {
    const associations = buildAssociations([
      { toId: input.contactId, typeId: 82 },
      { toId: input.dealId, typeId: 86 },
    ]);
    const json = await this.request<{ id?: string }>('POST', '/crm/v3/objects/communications', {
      properties: {
        hs_communication_channel_type: input.channel,
        hs_communication_body: input.body,
        hs_communication_logged_from: 'CRM',
        hs_timestamp: input.timestamp.toISOString(),
      },
      associations,
    });
    if (!json.id) throw new Error('HubSpot createCommunication: no id in response');
    logger.debug({ communicationId: json.id }, 'hubspot: communication engagement created');
    return { communicationId: json.id };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * One JSON request with retry on 429/5xx. Returns parsed JSON (or `{}` when
   * the response had no body, e.g. associate). Throws `HubSpotApiError` on
   * any non-2xx that survives the retry budget.
   */
  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.rawRequest(method, path, body);
      } catch (err) {
        // Network-layer failure (DNS, connection refused, timeout). Retry if
        // we have budget left; otherwise rethrow with a sanitized message.
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          const wait = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
          logger.warn(
            { method, path, attempt, err: err instanceof Error ? err.message : 'unknown' },
            'hubspot: network error, retrying',
          );
          await this.sleep(wait);
          continue;
        }
        throw err instanceof Error
          ? new Error(`HubSpot ${method} ${path} network error: ${err.message}`)
          : new Error(`HubSpot ${method} ${path} network error`);
      }

      if (res.status >= 200 && res.status < 300) {
        // 204 No Content + endpoints that return empty bodies (like associate).
        const text = await res.text();
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          // Non-JSON 2xx is unexpected but not fatal — return empty object so
          // callers downstream don't crash on a missing field.
          return {} as T;
        }
      }

      // Retryable: 429 + 5xx.
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const wait = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
        logger.warn(
          { method, path, status: res.status, attempt },
          'hubspot: retryable status, backing off',
        );
        await this.sleep(wait);
        continue;
      }

      // Non-retryable, OR retry budget exhausted. Build a PII-safe error.
      const errBodyText = await this.safeReadText(res);
      const parsed = this.tryParseErrorBody(errBodyText);
      throw new HubSpotApiError({
        method,
        path,
        status: res.status,
        body: errBodyText,
        code: parsed.code,
        missingProperty: parsed.missingProperty,
      });
    }

    // Unreachable — the loop always returns or throws — but TS needs it.
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`HubSpot ${method} ${path} failed after ${MAX_ATTEMPTS} attempts`);
  }

  private async rawRequest(method: string, path: string, body: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== null && body !== undefined ? { 'content-type': 'application/json' } : {}),
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };
    if (body !== null && body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return this.fetchImpl(url, init);
  }

  private async safeReadText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }

  /**
   * Best-effort parse of HubSpot's error JSON. We pull two things:
   *   - a short code/category for logs
   *   - the name of a property HubSpot rejected as nonexistent
   *
   * HubSpot's typical body looks like:
   *   {"status":"error","message":"Property values were not valid: ...",
   *    "category":"VALIDATION_ERROR",
   *    "errors":[{"message":"Property \"f16_lead_id\" does not exist", ...}]}
   *
   * The regex is conservative — failing to extract just leaves the field null.
   */
  private tryParseErrorBody(text: string): { code: string | null; missingProperty: string | null } {
    if (!text) return { code: null, missingProperty: null };
    let parsed: HubSpotErrorBody | null = null;
    try {
      parsed = JSON.parse(text) as HubSpotErrorBody;
    } catch {
      return { code: null, missingProperty: null };
    }

    const code = parsed.category ?? parsed.status ?? null;

    // Look in the top-level message and each sub-error for the "does not
    // exist" / "Property \"X\" does not exist" pattern.
    const candidates: string[] = [];
    if (parsed.message) candidates.push(parsed.message);
    for (const e of parsed.errors ?? []) {
      if (e.message) candidates.push(e.message);
    }

    for (const msg of candidates) {
      const m =
        msg.match(/Property\s+"([^"]+)"\s+does not exist/i) ??
        msg.match(/property\s+([a-z0-9_]+)\s+does not exist/i);
      if (m && m[1]) {
        return { code, missingProperty: m[1] };
      }
    }

    return { code, missingProperty: null };
  }
}
