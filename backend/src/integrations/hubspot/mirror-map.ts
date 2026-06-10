/**
 * Pure F16 → HubSpot property mapping. No IO, no logging of PII.
 *
 * `buildContactProps` and `buildDealProps` convert a `MirrorInput` snapshot
 * into HubSpot property bags ready for upsert/update calls. All transforms
 * are deterministic and side-effect free so they are trivially unit-testable.
 */

export type LeadStatus =
  | 'new'
  | 'scored'
  | 'qualifying'
  | 'quoting'
  | 'negotiating'
  | 'awaiting_payment'
  | 'closed_won'
  | 'closed_lost'
  | 'dormant';

export type StageKey =
  | 'nouveau'
  | 'qualifie'
  | 'devis_en_cours'
  | 'devis_envoye'
  | 'attente_paiement'
  | 'gagne'
  | 'perdu';

export interface MirrorInput {
  lead: {
    id: string;
    status: LeadStatus;
    source: string;
    productLine: 'scooter' | 'car';
    score: number | null;
    preferredChannel: 'whatsapp' | 'call' | null;
    preferredTime: string | null;
  };
  customer: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null; // decrypted JSON string
    vehicle: unknown; // jsonb
  };
  latestQuote: {
    status: string;
    monthlyPremium: string | null;
    comptantDue: string | null;
    maxanceDevisNumber: string | null;
    productVariant: string;
  } | null;
}

const STATUS_TO_STAGE: Record<LeadStatus, StageKey | null> = {
  new: 'nouveau',
  scored: 'nouveau',
  qualifying: 'qualifie',
  quoting: 'devis_en_cours',
  negotiating: 'devis_envoye',
  awaiting_payment: 'attente_paiement',
  closed_won: 'gagne',
  closed_lost: 'perdu',
  dormant: null, // leave stage unchanged
};

export function stageKeyForStatus(status: LeadStatus): StageKey | null {
  return STATUS_TO_STAGE[status];
}

function parseAddress(raw: string | null): { address?: string; city?: string; zip?: string } {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const out: { address?: string; city?: string; zip?: string } = {};
    const line = j['line1'] ?? j['address'] ?? j['street'];
    const city = j['city'] ?? j['ville'];
    const zip = j['postalCode'] ?? j['zip'] ?? j['codePostal'];
    if (typeof line === 'string' && line.trim()) out.address = line.trim();
    if (typeof city === 'string' && city.trim()) out.city = city.trim();
    if (typeof zip === 'string' && zip.trim()) out.zip = zip.trim();
    return out;
  } catch {
    return {};
  }
}

function vehicleLabel(vehicle: unknown): string | undefined {
  if (!vehicle || typeof vehicle !== 'object') return undefined;
  const v = vehicle as Record<string, unknown>;
  const parts = [v['brand'], v['model']].filter(
    (x): x is string => typeof x === 'string' && x.trim() !== '',
  );
  if (parts.length > 0) return parts.join(' ');
  const single = v['label'] ?? v['name'] ?? v['model'];
  return typeof single === 'string' && single.trim() ? single.trim() : undefined;
}

function splitName(fullName: string | null): { firstName?: string; lastName?: string } {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return {};
  const [first, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const out: { firstName?: string; lastName?: string } = {};
  if (first) out.firstName = first;
  if (rest.length > 0) out.lastName = rest.join(' ');
  return out;
}

export function buildContactProps(input: MirrorInput): Record<string, string> {
  const { lead, customer } = input;
  const name = splitName(customer.fullName);
  const addr = parseAddress(customer.address);
  const p: Record<string, string> = {
    f16_lead_id: lead.id,
    f16_source: lead.source,
  };
  if (name.firstName) p.firstname = name.firstName;
  if (name.lastName) p.lastname = name.lastName;
  if (customer.email) p.email = customer.email;
  if (customer.phone) p.phone = customer.phone;
  if (addr.address) p.address = addr.address;
  if (addr.city) p.city = addr.city;
  if (addr.zip) p.zip = addr.zip;
  if (lead.preferredChannel) p.f16_preferred_channel = lead.preferredChannel;
  if (lead.preferredTime) p.f16_preferred_time = lead.preferredTime;
  return p;
}

export function buildDealProps(input: MirrorInput): Record<string, string | number> {
  const { lead, customer, latestQuote } = input;
  const product = lead.productLine === 'scooter' ? 'Trottinette' : 'Auto';
  const subject = (customer.fullName && customer.fullName.trim()) || customer.email || 'Lead';
  const p: Record<string, string | number> = {
    dealname: `${product} — ${subject}`,
    product_line: lead.productLine,
    f16_lead_id: lead.id,
    f16_dormant: lead.status === 'dormant' ? 'true' : 'false',
  };
  if (typeof lead.score === 'number') p.f16_lead_score = lead.score;
  const veh = vehicleLabel(customer.vehicle);
  if (veh) p.f16_vehicle = veh;
  if (latestQuote) {
    const monthly = latestQuote.monthlyPremium != null ? Number(latestQuote.monthlyPremium) : NaN;
    const comptant = latestQuote.comptantDue != null ? Number(latestQuote.comptantDue) : NaN;
    if (Number.isFinite(monthly)) p.amount = monthly;
    if (Number.isFinite(comptant)) p.f16_comptant_due = comptant;
    if (latestQuote.maxanceDevisNumber) p.f16_devis_number = latestQuote.maxanceDevisNumber;
  }
  return p;
}
