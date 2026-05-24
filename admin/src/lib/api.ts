/**
 * Thin fetch wrapper for the admin API (option D).
 *
 * All admin endpoints live under /v1/admin/* — the Vite dev proxy
 * forwards both /v1 and /ws to the local backend, so the admin uses
 * RELATIVE URLs in both dev and prod (no VITE_API_BASE_URL needed).
 *
 * Throws ApiError on non-2xx so React Query surfaces failures cleanly.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 240);
    } catch {
      /* noop */
    }
    throw new ApiError(`HTTP ${res.status} on ${path}${detail ? ` — ${detail}` : ''}`, res.status);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 409) {
    // 409 from /resolve = already-resolved; surfaces in `alreadyResolved` flag
    // rather than as an error so the UI can refresh without showing a banner.
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 240);
    } catch {
      /* noop */
    }
    throw new ApiError(`HTTP ${res.status} on ${path}${detail ? ` — ${detail}` : ''}`, res.status);
  }
  return (await res.json()) as T;
}

/** Shape of one row returned by GET /v1/admin/leads (mirrors backend LeadRow). */
export interface LeadRow {
  leadId: string;
  customerId: string | null;
  customerName: string | null;
  source: string;
  productLine: string;
  status: string;
  score: number | null;
  createdAt: string;
  hubspotDealId: string | null;
}

export interface ListLeadsResponse {
  rows: LeadRow[];
  pagination: { limit: number; offset: number; returned: number };
}

export function listLeads(
  opts: { limit?: number; offset?: number } = {},
): Promise<ListLeadsResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return apiGet<ListLeadsResponse>(`/v1/admin/leads${qs ? `?${qs}` : ''}`);
}

// ----- M14 V1: lead detail -------------------------------------------------

export interface LeadDetail {
  lead: {
    id: string;
    status: string;
    source: string;
    sourceId: string | null;
    productLine: string;
    score: number | null;
    hubspotDealId: string | null;
    createdAt: string;
    scoredAt: string | null;
    updatedAt: string;
  };
  customer: {
    id: string;
    displayName: string | null;
    civility: string | null;
    hasPhone: boolean;
    hasEmail: boolean;
    vehicle: Record<string, unknown> | null;
    driver: Record<string, unknown> | null;
    createdAt: string;
  } | null;
  turns: Array<{
    id: string;
    channel: string;
    direction: 'inbound' | 'outbound';
    agentRole: string | null;
    agentInstance: string | null;
    content: string;
    occurredAt: string;
  }>;
  quotes: Array<{
    id: string;
    status: string;
    product: string;
    productVariant: string;
    monthlyPremiumEur: number | null;
    comptantDueEur: number | null;
    maxanceDevisNumber: string | null;
    requestedAt: string;
    readyAt: string | null;
    deliveredAt: string | null;
  }>;
  humanActions: Array<{
    id: string;
    intent: string;
    severity: number;
    status: string;
    summary: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
}

export function getLeadDetail(leadId: string): Promise<LeadDetail> {
  return apiGet<LeadDetail>(`/v1/admin/leads/${encodeURIComponent(leadId)}`);
}

// ----- M14 V1: human actions queue ----------------------------------------

export interface HumanActionOption {
  id: string;
  label: string;
  kind: 'approve' | 'reject' | 'revise' | string;
}

export interface HumanActionRow {
  id: string;
  createdByAgent: string;
  intent: string;
  severity: number;
  status: string;
  summary: string;
  options: HumanActionOption[];
  correlationId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedSource: string | null;
  resolution: Record<string, unknown> | null;
}

export interface ListHumanActionsResponse {
  rows: HumanActionRow[];
}

export function listPendingHumanActions(
  opts: { severity?: 1 | 2 | 3; limit?: number } = {},
): Promise<ListHumanActionsResponse> {
  const params = new URLSearchParams();
  if (opts.severity !== undefined) params.set('severity', String(opts.severity));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return apiGet<ListHumanActionsResponse>(`/v1/admin/human-actions${qs ? `?${qs}` : ''}`);
}

export interface ResolveHumanActionResponse {
  row: HumanActionRow;
  alreadyResolved: boolean;
}

export function resolveHumanAction(
  id: string,
  body: { chosenOptionId: string; notes?: string; by?: string },
): Promise<ResolveHumanActionResponse> {
  return apiPost<ResolveHumanActionResponse>(
    `/v1/admin/human-actions/${encodeURIComponent(id)}/resolve`,
    body,
  );
}

// ----- M13: audit log -----------------------------------------------------

export interface AuditRow {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  occurredAt: string;
}

export interface ListAuditResponse {
  rows: AuditRow[];
  pagination: { limit: number; offset: number; returned: number };
}

export interface ListAuditOptions {
  since?: string;
  until?: string;
  actorId?: string;
  actionPrefix?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
}

export function listAudit(opts: ListAuditOptions = {}): Promise<ListAuditResponse> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return apiGet<ListAuditResponse>(`/v1/admin/audit${qs ? `?${qs}` : ''}`);
}

/** Build a URL for the streaming NDJSON export. The browser triggers a download via window.open. */
export function buildAuditExportUrl(opts: ListAuditOptions & { redactPii?: boolean } = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== '' && v !== false) params.set(k, String(v));
  }
  const qs = params.toString();
  return `/v1/admin/audit/export${qs ? `?${qs}` : ''}`;
}
