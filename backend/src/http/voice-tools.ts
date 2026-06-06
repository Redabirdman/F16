/**
 * Voice tool layer for OpenAI Realtime native SIP (M10 V2, Phases A+B).
 *
 * The native-SIP model handles the conversation; our backend stays the brain by
 * exposing TOOLS over the control WebSocket. Rather than duplicate logic, each
 * voice tool maps onto an EXISTING builtin (src/tools/builtins/*) through the
 * typed `invokeTool` registry — same knowledge search, quote pipeline, and
 * human-escalation the WhatsApp brain uses.
 *
 *   consulter_catalogue       -> knowledge.search       (ground answers)
 *   enregistrer_qualification -> audit_log append       (capture progress)
 *   demander_devis            -> quote.request          (real Maxance devis, async)
 *   transferer_conseiller     -> human.escalate         (WhatsApp group + admin)
 *   programmer_rappel         -> human.escalate (callback intent)
 *   consulter_profil          -> customer.read_profile  (returning-customer context)
 *
 * Tools needing a resolved lead/customer (demander_devis, consulter_profil)
 * degrade gracefully when the call has no identity: they return a French status
 * telling the model to take qualification info verbally / escalate, never throw
 * into the live call.
 *
 * PII: tool outputs returned to the model may contain the customer's name
 * (consulter_profil) — that's spoken back to that same customer, which is fine.
 * We never LOG tool outputs.
 */
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { invokeTool } from '../tools/registry.js';
import '../tools/builtins/index.js'; // side-effect: register the builtins
import { appendAudit } from '../db/repositories/audit-log.js';

/** Identity + correlation for the live call (subset of openai-sip CallContext). */
export interface VoiceToolCtx {
  sipCallId: string;
  leadId?: string;
  customerId?: string;
}

/**
 * OpenAI function-tool schemas advertised in the realtime session. Names are
 * French + spoken-domain so the model calls them naturally; parameters are the
 * minimum the mapped builtin needs.
 */
export const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'consulter_catalogue',
    description:
      'Rechercher dans la base de connaissances Assuryal (produits, garanties, réglementation, FAQ) pour répondre précisément à une question que tu ne connais pas déjà. À utiliser avec parcimonie.',
    parameters: {
      type: 'object',
      properties: {
        sujet: {
          type: 'string',
          description: 'La question ou le sujet à rechercher, en français.',
        },
      },
      required: ['sujet'],
    },
  },
  {
    type: 'function',
    name: 'enregistrer_qualification',
    description:
      "Enregistrer en arrière-plan les informations de qualification dès qu'elles sont connues. Continue la conversation normalement.",
    parameters: {
      type: 'object',
      properties: {
        produit: { type: 'string', description: 'trottinette, scooter, moto, auto, ou autre' },
        type_vehicule: { type: 'string', description: 'électrique ou mécanique, si pertinent' },
        usage: { type: 'string', description: 'quotidien ou occasionnel' },
        vitesse_max_kmh: { type: 'number' },
        etat_achat: { type: 'string', description: 'neuf ou occasion' },
        date_achat: { type: 'string', description: 'date approximative si fournie' },
        notes: { type: 'string', description: 'autre détail utile' },
      },
      required: ['produit'],
    },
  },
  {
    type: 'function',
    name: 'demander_devis',
    description:
      "Lancer le devis officiel d'assurance TROTTINETTE une fois les 5 champs réunis. Le devis se prépare en arrière-plan (~20 s) ; annonce ensuite au client qu'il le recevra et qu'un conseiller revient vers lui.",
    parameters: {
      type: 'object',
      properties: {
        prix_achat_eur: { type: 'number', description: "Prix d'achat de la trottinette en euros." },
        date_achat: { type: 'string', description: "Date d'achat au format AAAA-MM-JJ." },
        code_postal: { type: 'string', description: 'Code postal à 5 chiffres.' },
        date_naissance: { type: 'string', description: 'Date de naissance au format AAAA-MM-JJ.' },
        stationnement: {
          type: 'string',
          enum: ['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue'],
          description:
            'Où la trottinette dort la nuit: garage_box (garage fermé), parking_prive_clos, parking_prive_non_clos, ou rue.',
        },
      },
      required: ['prix_achat_eur', 'date_achat', 'code_postal', 'date_naissance', 'stationnement'],
    },
  },
  {
    type: 'function',
    name: 'transferer_conseiller',
    description:
      'Transférer la demande à un conseiller humain (Ridaa ou Achraf). OBLIGATOIRE si le client demande un remboursement, conteste un contrat, parle de litige/avocat/ACPR/plainte, veut résilier, demande un humain, finalise un paiement/contrat, ou situation hors-cadre.',
    parameters: {
      type: 'object',
      properties: {
        raison: { type: 'string', description: 'Résumé en français de la demande à transmettre.' },
        urgence: {
          type: 'number',
          enum: [1, 2, 3],
          description: '1=critique, 2=standard, 3=info.',
        },
      },
      required: ['raison'],
    },
  },
  {
    type: 'function',
    name: 'programmer_rappel',
    description:
      'Programmer un rappel par un conseiller si le client ne peut pas parler maintenant ou préfère être rappelé plus tard.',
    parameters: {
      type: 'object',
      properties: {
        creneau: {
          type: 'string',
          description: 'Créneau souhaité, en français (ex: demain matin).',
        },
        raison: { type: 'string', description: 'Contexte / motif du rappel.' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'consulter_profil',
    description:
      "Récupérer le profil du client (nom, véhicule connu) pour personnaliser l'accueil d'un client existant.",
    parameters: { type: 'object', properties: {} },
  },
] as const;

/** Build the registry ToolContext for this call. */
function toolCtx(db: Database, ctx: VoiceToolCtx) {
  return {
    db,
    agentRole: 'sales-agent',
    agentInstance: `voice-${ctx.sipCallId}`,
    ...(ctx.leadId ? { correlationId: ctx.leadId } : {}),
  };
}

/**
 * Dispatch a model tool call to the mapped builtin and return the string that
 * goes back as the function_call_output. Never throws into the live call —
 * failures return a short French status the model can act on.
 */
export async function handleVoiceTool(
  db: Database,
  ctx: VoiceToolCtx,
  name: string,
  argsRaw: string | undefined,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = argsRaw ? (JSON.parse(argsRaw) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ statut: 'erreur', message: 'arguments illisibles' });
  }

  try {
    switch (name) {
      case 'consulter_catalogue': {
        const hits = (await invokeTool(toolCtx(db, ctx), 'knowledge.search', {
          query: String(args.sujet ?? ''),
          limit: 4,
        })) as Array<{ chunk: string; source: string }>;
        if (!hits.length) return JSON.stringify({ resultats: [], note: 'rien trouvé' });
        return JSON.stringify({ resultats: hits.map((h) => h.chunk).slice(0, 4) });
      }

      case 'enregistrer_qualification': {
        await appendAudit(db, {
          actorType: 'agent',
          actorId: 'voice-sales-agent',
          action: 'voice.qualification.record',
          targetType: ctx.leadId ? 'lead' : 'call',
          targetId: ctx.leadId ?? ctx.sipCallId,
          meta: { callId: ctx.sipCallId, ...args },
        });
        logger.info({ callId: ctx.sipCallId }, 'voice-tools: qualification recorded');
        return JSON.stringify({ statut: 'enregistré' });
      }

      case 'demander_devis': {
        if (!ctx.customerId || !ctx.leadId) {
          return JSON.stringify({
            statut: 'identite_manquante',
            message:
              'Impossible de lancer le devis automatique pour cet appel. Note les infos et propose un rappel par un conseiller.',
          });
        }
        const res = (await invokeTool(toolCtx(db, ctx), 'quote.request', {
          customerId: ctx.customerId,
          leadId: ctx.leadId,
          formData: {
            vehicleKind: 'trottinette',
            purchasePriceEur: Number(args.prix_achat_eur),
            purchaseDate: String(args.date_achat),
            postalCode: String(args.code_postal),
            clientDateOfBirth: String(args.date_naissance),
            stationnement: args.stationnement,
          },
        })) as { quoteId: string };
        logger.info(
          { callId: ctx.sipCallId, quoteId: res.quoteId },
          'voice-tools: devis requested',
        );
        return JSON.stringify({
          statut: 'devis_lancé',
          message:
            'Le devis se prépare (~20s) et sera envoyé ; un conseiller revient vers le client.',
        });
      }

      case 'transferer_conseiller': {
        const sev = args.urgence === 1 || args.urgence === 3 ? args.urgence : 2;
        await invokeTool(toolCtx(db, ctx), 'human.escalate', {
          intent: 'VOICE.HANDOFF',
          severity: sev,
          summary: `[Appel vocal] ${String(args.raison ?? 'transfert demandé')}`,
          ...(ctx.leadId ? { correlationId: ctx.leadId } : {}),
        });
        logger.info({ callId: ctx.sipCallId }, 'voice-tools: escalated to human');
        return JSON.stringify({
          statut: 'transféré',
          message: 'Un conseiller va prendre le relais.',
        });
      }

      case 'programmer_rappel': {
        const when = args.creneau ? ` (${String(args.creneau)})` : '';
        await invokeTool(toolCtx(db, ctx), 'human.escalate', {
          intent: 'CALLBACK.REQUESTED',
          severity: 3,
          summary: `[Rappel vocal demandé${when}] ${String(args.raison ?? '')}`.trim(),
          ...(ctx.leadId ? { correlationId: ctx.leadId } : {}),
        });
        logger.info({ callId: ctx.sipCallId }, 'voice-tools: callback scheduled');
        return JSON.stringify({ statut: 'rappel_programmé' });
      }

      case 'consulter_profil': {
        if (!ctx.customerId) return JSON.stringify({ statut: 'client_inconnu' });
        const p = (await invokeTool(toolCtx(db, ctx), 'customer.read_profile', {
          customerId: ctx.customerId,
        })) as { fullName: string; civility: string | null; vehicle: unknown };
        return JSON.stringify({
          civilite: p.civility,
          nom: p.fullName,
          vehicule_connu: p.vehicle ?? null,
        });
      }

      default:
        logger.warn({ callId: ctx.sipCallId, name }, 'voice-tools: unknown tool');
        return JSON.stringify({ statut: 'outil_inconnu' });
    }
  } catch (err) {
    logger.warn(
      { callId: ctx.sipCallId, name, err: err instanceof Error ? err.message : String(err) },
      'voice-tools: tool handler failed',
    );
    return JSON.stringify({
      statut: 'erreur',
      message: 'Une difficulté technique est survenue ; propose un rappel par un conseiller.',
    });
  }
}
