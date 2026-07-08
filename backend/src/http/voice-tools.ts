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
 *   demander_devis            -> quote.request          (price menu prep, async)
 *   confirmer_devis           -> quote.confirm          (REAL Maxance devis PDF)
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
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { logger } from '../logger.js';
import { invokeTool } from '../tools/registry.js';
import '../tools/builtins/index.js'; // side-effect: register the builtins
import { appendAudit } from '../db/repositories/audit-log.js';
import { quotes } from '../db/schema/index.js';

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
      "Lancer le calcul du tarif d'assurance TROTTINETTE une fois les 5 champs réunis. Le calcul tourne en arrière-plan (~20 s) ; le client reçoit ensuite sur WhatsApp (et par email) un MENU de tarifs : 3 formules aux prix mensuels réels, 2 options, et un pack conseillé. Annonce-lui ce menu et invite-le à répondre sur WhatsApp OU à te donner son choix au téléphone (appelle alors confirmer_devis).",
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
    name: 'confirmer_devis',
    description:
      "Générer le devis Maxance OFFICIEL (PDF envoyé au client par WhatsApp + email) quand le client annonce son choix de formule AU TÉLÉPHONE, après demander_devis. Passe la formule choisie et avec_options=true si le client prend les 2 options (Assistance Mobilité + Garantie Personnelle du Conducteur). Si le résultat est champs_manquants, demande la civilité et l'adresse postale complète puis rappelle l'outil en les passant. Si le résultat est recalcul_en_cours, attends une petite minute puis rappelle l'outil.",
    parameters: {
      type: 'object',
      properties: {
        formule: {
          type: 'string',
          enum: ['tiers_illimite', 'vol_incendie', 'dommages_tous_accidents'],
          description:
            'Formule choisie : tiers_illimite (Tiers Illimité), vol_incendie (Tiers + Vol & Incendie), dommages_tous_accidents (Tous Risques). Omets-la si le client valide la formule déjà proposée.',
        },
        avec_options: {
          type: 'boolean',
          description:
            'true si le client prend les 2 options du pack : Assistance Mobilité (~1 €/mois) et Garantie Personnelle du Conducteur (~1,50 €/mois).',
        },
        civilite: {
          type: 'string',
          enum: ['monsieur', 'madame'],
          description: "Civilité du client, si donnée pendant l'appel.",
        },
        adresse_ligne: {
          type: 'string',
          description: "Numéro et rue de l'adresse postale du client, si donnés pendant l'appel.",
        },
        code_postal: {
          type: 'string',
          description: "Code postal (5 chiffres) de l'adresse postale du client.",
        },
        ville: { type: 'string', description: "Ville de l'adresse postale du client." },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'transferer_conseiller',
    description:
      'Transférer la demande à un conseiller humain Assuryal (ne JAMAIS citer de prénom interne au client). OBLIGATOIRE si le client demande un remboursement, conteste un contrat, parle de litige/avocat/ACPR/plainte, veut résilier, demande un humain, finalise un paiement/contrat, ou situation hors-cadre.',
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
  {
    type: 'function',
    name: 'terminer_appel',
    description:
      "Raccrocher l'appel. À appeler (1) si tu détectes une MESSAGERIE VOCALE / un répondeur (ex: 'laissez un message après le bip', 'votre correspondant n'est pas disponible', 'boîte vocale') — n'engage alors PAS de conversation ; (2) quand l'échange est terminé et que tu as dit au revoir.",
    parameters: {
      type: 'object',
      properties: {
        raison: {
          type: 'string',
          enum: ['messagerie_vocale', 'echange_termine', 'autre'],
          description: 'Pourquoi tu raccroches.',
        },
      },
      required: ['raison'],
    },
  },
] as const;

/** Tool names that openai-sip handles itself (need call/WS control, not a builtin). */
export const VOICE_TRANSPORT_TOOLS = new Set(['terminer_appel']);

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
        // Validate BEFORE quote.request so a bad/partial field (e.g. a 2-digit
        // postal code the caller half-said) makes the model re-ask instead of
        // erroring out.
        const manquants: string[] = [];
        const prix = Number(args.prix_achat_eur);
        if (!Number.isFinite(prix) || prix <= 0) manquants.push('prix_achat_eur');
        if (!/^\d{5}$/.test(String(args.code_postal ?? ''))) manquants.push('code_postal');
        if (!/^\d{4}-\d{2}-\d{2}/.test(String(args.date_achat ?? ''))) manquants.push('date_achat');
        if (!/^\d{4}-\d{2}-\d{2}/.test(String(args.date_naissance ?? '')))
          manquants.push('date_naissance');
        if (
          !['garage_box', 'parking_prive_clos', 'parking_prive_non_clos', 'rue'].includes(
            String(args.stationnement ?? ''),
          )
        )
          manquants.push('stationnement');
        if (manquants.length > 0) {
          return JSON.stringify({
            statut: 'champs_incomplets',
            manquants,
            message: `Redemande gentiment au client: ${manquants.join(', ')} (code postal = 5 chiffres, dates au format AAAA-MM-JJ).`,
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
            'Le calcul est lancé (~20s). Le client recevra sur WhatsApp et par email un menu de ' +
            'tarifs (3 formules aux prix mensuels réels, 2 options, pack conseillé) — invite-le à ' +
            'répondre sur WhatsApp ou à te donner son choix au téléphone.',
        });
      }

      case 'confirmer_devis': {
        if (!ctx.customerId || !ctx.leadId) {
          return JSON.stringify({
            statut: 'identite_manquante',
            message:
              'Impossible de confirmer un devis pour cet appel. Note le choix du client et propose un rappel par un conseiller.',
          });
        }

        // The latest quote is the one parked on the Maxance Garanties tab —
        // its formule (default tiers_illimite) is what a confirm would lock
        // in. If the caller picked ANOTHER formule, re-run quote.request with
        // the stored formData so the official devis matches the choice.
        const [latest] = await db
          .select({ id: quotes.id, rawFormData: quotes.rawFormData })
          .from(quotes)
          .where(eq(quotes.leadId, ctx.leadId))
          .orderBy(desc(quotes.requestedAt))
          .limit(1);
        if (!latest) {
          return JSON.stringify({
            statut: 'devis_inexistant',
            message:
              "Aucun tarif n'a encore été calculé pour cet appel — appelle d'abord demander_devis avec les 5 champs.",
          });
        }

        const avecOptions = args.avec_options === true;
        const garanties = avecOptions ? { assistance: true, garantiePersonnelle: true } : undefined;

        const formData = (latest.rawFormData ?? {}) as Record<string, unknown>;
        const formuleActuelle =
          typeof formData['formule'] === 'string' ? formData['formule'] : 'tiers_illimite';
        const formuleChoisie = [
          'tiers_illimite',
          'vol_incendie',
          'dommages_tous_accidents',
        ].includes(String(args.formule ?? ''))
          ? String(args.formule)
          : undefined;
        if (formuleChoisie && formuleChoisie !== formuleActuelle) {
          if (formData['vehicleKind'] !== 'trottinette') {
            return JSON.stringify({
              statut: 'erreur',
              message:
                'Impossible de recalculer cette formule automatiquement ; propose un rappel par un conseiller.',
            });
          }
          const nextFormData: Record<string, unknown> = { ...formData, formule: formuleChoisie };
          if (args.avec_options === true) nextFormData['garantiesAdditionnelles'] = garanties;
          else if (args.avec_options === false) delete nextFormData['garantiesAdditionnelles'];
          await invokeTool(toolCtx(db, ctx), 'quote.request', {
            customerId: ctx.customerId,
            leadId: ctx.leadId,
            formData: nextFormData,
          });
          logger.info(
            { callId: ctx.sipCallId, formule: formuleChoisie },
            'voice-tools: formule changed, devis re-requested before confirm',
          );
          return JSON.stringify({
            statut: 'recalcul_en_cours',
            message:
              'La formule choisie est en cours de recalcul (moins d’une minute). Garde la conversation vivante puis rappelle confirmer_devis avec le même choix.',
          });
        }

        // Civilité/adresse the caller just gave verbally. Persist the durable
        // copy on the profile FIRST (quote.confirm defaults from it — same as
        // the WhatsApp playbook §6), then pass them explicitly to the confirm.
        const civilite =
          args.civilite === 'monsieur' || args.civilite === 'madame' ? args.civilite : undefined;
        const adresseLigne =
          typeof args.adresse_ligne === 'string' && args.adresse_ligne.trim().length > 0
            ? args.adresse_ligne.trim()
            : undefined;
        const codePostal = /^\d{5}$/.test(String(args.code_postal ?? ''))
          ? String(args.code_postal)
          : undefined;
        const ville =
          typeof args.ville === 'string' && args.ville.trim().length > 0
            ? args.ville.trim()
            : undefined;
        if (civilite && adresseLigne && codePostal && ville) {
          try {
            await invokeTool(toolCtx(db, ctx), 'customer.update_profile', {
              customerId: ctx.customerId,
              fields: {
                address: { line1: adresseLigne, postalCode: codePostal, city: ville, civilite },
              },
            });
          } catch (err) {
            // Best-effort — the explicit params below still reach quote.confirm.
            logger.warn(
              { callId: ctx.sipCallId, err: err instanceof Error ? err.message : String(err) },
              'voice-tools: profile address store failed (non-fatal)',
            );
          }
        }

        try {
          const res = (await invokeTool(toolCtx(db, ctx), 'quote.confirm', {
            customerId: ctx.customerId,
            leadId: ctx.leadId,
            // quoteId omitted on purpose — quote.confirm resolves the lead's
            // latest quote, which is the one parked on the Maxance tab.
            ...(civilite ? { civilite } : {}),
            ...(adresseLigne ? { addressLine: adresseLigne } : {}),
            ...(codePostal ? { postalCode: codePostal } : {}),
            ...(ville ? { city: ville } : {}),
            ...(garanties ? { garantiesAdditionnelles: garanties } : {}),
          })) as { quoteId: string };
          logger.info(
            { callId: ctx.sipCallId, quoteId: res.quoteId, addOns: garanties ?? null },
            'voice-tools: devis confirmed',
          );
          return JSON.stringify({
            statut: 'devis_confirmé',
            reference: res.quoteId,
            info: 'le devis PDF arrive par WhatsApp et email dans quelques minutes',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // quote.confirm throws a descriptive French error listing the
          // missing subscriber fields — turn it into a status so the model
          // ASKS the caller (civilité, adresse) and retries instead of
          // erroring the live call.
          if (msg.includes('souscripteur manquantes')) {
            return JSON.stringify({
              statut: 'champs_manquants',
              details: msg,
              message:
                'Demande au client sa civilité (Monsieur ou Madame) et son adresse postale complète (numéro et rue, code postal, ville), puis rappelle confirmer_devis en les passant.',
            });
          }
          throw err; // outer catch → generic French status
        }
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
