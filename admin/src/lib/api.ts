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
