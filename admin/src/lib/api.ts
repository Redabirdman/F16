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

const ADMIN_TOKEN_KEY = 'f16.adminToken';

/** Read the operator's admin bearer token (set via the auth prompt). */
export function getAdminToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(ADMIN_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Persist the operator's admin bearer token. Empty string clears it. */
export function setAdminToken(token: string): void {
  try {
    if (token) globalThis.localStorage?.setItem(ADMIN_TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* noop — no localStorage (SSR / private mode) */
  }
}

function authHeaders(): Record<string, string> {
  const t = getAdminToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json', ...authHeaders() },
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
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders() },
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
  // The bearer token can't ride in an EventSource / `<a href>` request header,
  // so for downloadable endpoints we pass it as a query param the backend
  // auth middleware also accepts (see admin/auth.ts). The token shouldn't
  // appear in browser history because the operator clicks Export rather
  // than typing the URL.
  const token = getAdminToken();
  if (token) params.set('token', token);
  const qs = params.toString();
  return `/v1/admin/audit/export${qs ? `?${qs}` : ''}`;
}

// ----- M14.T3: dashboard ---------------------------------------------------

export interface DashboardKpis {
  generatedAt: string;
  leads: { totalLast24h: number; byStatusAllTime: Record<string, number> };
  humanActions: {
    pendingTotal: number;
    pendingBySeverity: { critical: number; standard: number; info: number };
  };
  conversation: { inboundLast24h: number; outboundLast24h: number };
  quotes: { totalLast24h: number; byStatusAllTime: Record<string, number> };
}

export function getDashboardKpis(): Promise<DashboardKpis> {
  return apiGet<DashboardKpis>('/v1/admin/dashboard/kpis');
}

// ----- M14.T7: integrations health -----------------------------------------

export type IntegrationStatus = 'ok' | 'unconfigured' | 'unreachable' | 'degraded';

export interface IntegrationHealth {
  name: string;
  status: IntegrationStatus;
  detail?: string;
  durationMs?: number;
  required: boolean;
}

export interface IntegrationsHealthResponse {
  generatedAt: string;
  integrations: IntegrationHealth[];
}

export function getIntegrationsHealth(): Promise<IntegrationsHealthResponse> {
  return apiGet<IntegrationsHealthResponse>('/v1/admin/integrations/health');
}

// ----- M15.T2: agents registry view + kill / setPriority -------------------

export interface AgentStateRow {
  role: string;
  instanceId: string;
  model: string;
  queue: string;
  status: string;
  priority: number | null;
  startedAt: string;
  lastHeartbeatAt: string;
  stoppedAt: string | null;
  error: string | null;
  inMemory: boolean;
}

export interface ListAgentsResponse {
  rows: AgentStateRow[];
}

export function listAgents(): Promise<ListAgentsResponse> {
  return apiGet<ListAgentsResponse>('/v1/admin/agents');
}

export interface KillAgentResponse {
  ok: boolean;
  alreadyStopped: boolean;
}

export function killAgent(role: string, instanceId: string): Promise<KillAgentResponse> {
  return apiPost<KillAgentResponse>(
    `/v1/admin/agents/${encodeURIComponent(role)}/${encodeURIComponent(instanceId)}/kill`,
    {},
  );
}

export interface SetPriorityResponse {
  ok: boolean;
  priority: number;
}

export function setAgentPriority(
  role: string,
  instanceId: string,
  priority: number,
): Promise<SetPriorityResponse> {
  return apiPost<SetPriorityResponse>(
    `/v1/admin/agents/${encodeURIComponent(role)}/${encodeURIComponent(instanceId)}/priority`,
    { priority, by: 'admin-ui' },
  );
}

// ----- M14 V2.5: ads surface (campaigns / creatives / creative_learnings) ---

export interface AdminCampaign {
  id: string;
  metaCampaignId: string;
  name: string;
  objective: string | null;
  status: string | null;
  productLine: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  currency: string;
  adsetCount: number;
  adCount: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AdminCreative {
  id: string;
  name: string;
  angle: string;
  productLine: string | null;
  format: string;
  headline: string | null;
  subCopy: string | null;
  ctaText: string | null;
  fileUrl: string;
  generatedBy: string | null;
  createdAt: string;
}

export interface AdminCreativeLearning {
  id: string;
  angle: string | null;
  guidance: string;
  sourceFeedback: string | null;
  createdByAgent: string | null;
  createdAt: string;
}

export interface AdsResponse {
  generatedAt: string;
  campaigns: AdminCampaign[];
  creatives: AdminCreative[];
  learnings: AdminCreativeLearning[];
}

export function getAds(): Promise<AdsResponse> {
  return apiGet<AdsResponse>('/v1/admin/ads');
}

// ----- M14.T8: knowledge semantic search ------------------------------------

export interface KnowledgeSearchHit {
  id: string;
  source: string;
  sourcePath: string | null;
  sourceUrl: string | null;
  chunkText: string;
  distance: number;
  similarity: number;
  ingestedAt: string | null;
}

export interface KnowledgeSearchResponse {
  query: string;
  generatedAt: string;
  results: KnowledgeSearchHit[];
}

export function searchKnowledge(query: string, limit = 10): Promise<KnowledgeSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiGet<KnowledgeSearchResponse>(`/v1/admin/knowledge/search?${params.toString()}`);
}

// ----- M14.T6: agent prompt editor ------------------------------------------

async function apiSend<T>(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

export interface PromptInfo {
  key: string;
  label: string;
  agentRole: string;
  description: string;
  default: string;
  override: string | null;
  isOverridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function listPrompts(): Promise<{ prompts: PromptInfo[] }> {
  return apiGet<{ prompts: PromptInfo[] }>('/v1/admin/prompts');
}

export function savePrompt(key: string, content: string): Promise<{ ok: boolean; key: string }> {
  return apiSend('PUT', `/v1/admin/prompts/${encodeURIComponent(key)}`, { content });
}

export function resetPrompt(key: string): Promise<{ ok: boolean; key: string }> {
  return apiSend('DELETE', `/v1/admin/prompts/${encodeURIComponent(key)}`);
}

// ----- M14.T10: team-chat ---------------------------------------------------

export type TeamChatEntry =
  | {
      kind: 'request';
      at: string;
      id: string;
      intent: string;
      severity: number;
      summary: string;
      correlationId: string | null;
    }
  | {
      kind: 'resolved';
      at: string;
      id: string;
      choice: string | null;
      by: string | null;
      source: string | null;
    }
  | { kind: 'sent'; at: string; text: string };

export interface TeamChatResponse {
  generatedAt: string;
  entries: TeamChatEntry[];
}

export function getTeamChat(limit = 50): Promise<TeamChatResponse> {
  return apiGet<TeamChatResponse>(`/v1/admin/team-chat?limit=${limit}`);
}

export function sendTeamChat(text: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/v1/admin/team-chat/send', { text });
}
