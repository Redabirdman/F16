# M8.T7 — Maxance Closing — Implementation Plan

Spec: `docs/superpowers/specs/2026-06-11-m8t7-maxance-closing-design.md`. Subagent-driven build: each task = coder subagent → spec review + quality review → commit (lowercase subject, scope, Co-Authored-By: Claude Opus 4.8 (1M context)). Subagents commit, lead pushes.

## Conventions

- Extension flows follow the advance-loop contract (`.navigating` responses, URL-based screen detection, self-healing reset rules).
- Main-world dispatch for all Maxance framework interactions; `grep -c "__name" dist/background.js` must stay 0.
- DB-gated tests on `f16_test` (5435) only. IBAN/BIC never plaintext in logs.
- Selector constants live in `stagehand/src/maxance/selectors.ts` (single source of truth).

## File structure

| File                                                                                          | Responsibility                                                      | Status   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| `extension/src/flows/garanties-controls.ts`                                                   | applyGarantiesConfig + comptant extraction                          | new      |
| `extension/src/flows/devis-resume.ts`                                                         | search → visualisation → ACTION reprise → Garanties                 | new      |
| `extension/src/flows/subscription.ts`                                                         | Valider souscription → infos compl. → bancaires → paiement STOP     | new      |
| `extension/src/wire.ts`                                                                       | devis.resume + subscription.complete schemas                        | edit     |
| `extension/src/background.ts`                                                                 | orchestrator gates + contact-duplicate detection in devis MW bundle | edit     |
| `stagehand/src/maxance/selectors.ts`                                                          | new selectors/constants from live survey                            | edit     |
| `backend/src/intents/subscription.ts`                                                         | SUBSCRIPTION.\* intents                                             | new      |
| `backend/src/agents/maxance-operator/{agent,extension-client,driver-client,control-plane}.ts` | resumeDevis/completeSubscription + handler + endpoints              | edit     |
| `backend/src/db/schema/{quotes,customers}.ts` + migration                                     | subscription fields + encrypted bank columns                        | edit     |
| `backend/src/integrations/stripe/client.ts`                                                   | payment-link creation (feature-gated)                               | new      |
| `backend/src/tools/builtins/subscription-request.ts`                                          | sales tool (IBAN mod-97, emits intents)                             | new      |
| `backend/src/agents/sales-agent/prompts/playbook.ts` + knowledge doc                          | closing phase + Achraf knowledge (compliant)                        | edit/new |

## Phase A — Ground truth

- [x] **A1. Live DOM survey** — DONE 2026-06-11 on the real portal (devis DR0000976146, Ridaa authorized Valider souscription on the test instance). Full notes in ruflo `m8t7-live-DOM-survey-garanties-reprise-2026-06-11` + `m8t7-live-DOM-survey-souscription-pages-2026-06-11`. Key verified facts:
  - Search: `RechercheGeneriqueForm` — `select[name=critereSelected]`='NO', `#valeurCritere`=devis#, click `a#mainSearchLink` → "Visualisation du devis".
  - Reprise: `doSubmit('repriseDevisMoto.do')` (no params; session-scoped) → lands on **Véhicule** tab → Suivant ×2 (`#validerVehicule`, `#validerConducteur`) → Garanties (`#validerDevis` + `#validerSouscription`).
  - Garanties: formule radios `codeFormuleSelected` NV10/NV20/NV30 (onclick `submitFormule()`); commission input `#garantieTauxCommissionEffectif` — native set + blur (onblur `…setSliderValue0`) → AJAX ~6s → verified 78.85→83.71 at 22%; **commission resets to 9.0 on every reprise** → always re-apply; fractionnement `select[name="mouvement.codeFractionnement"]` M/S/A; frais comptant from hidden popup `#commptant_M` text "… 17.00 (Frais comptant) …".
  - Infos complémentaires: `mouvement.numeroSerieVehicule`='1234567'; Suivant = reused `#validerSouscription`.
  - Bancaires: IBAN parts `#ibanPart0..6` (4,4,4,4,4,4,3); BIC `bicIban.bic` (must match IBAN bank code — not auto-filled); `#nomTitulaireCompte`; lieu de naissance via `souscripteurNaissanceZonier.rechercheCommune` + its row search link (AJAX) → `souscripteurNaissanceZonier.key`; checkbox `flagPrimeRecue` ("Je dispose du comptant"); Valider = `doSubmitConfirm('SouscriptionContratVehiculeForm','souscriptionValiderFinaleMoto.do',labelAN)` then click **Valider** in the CONFIRMATION popin (never bypass via doSubmitForm → "Erreur applicative").
  - ⚠️ **Test RIBs rejected**: ALERTE "3_Validation impossible. Prélèvement sur RIB de test non autorisé" → flow must surface `maxance_subscription_rib_rejected`; the **Paiement page is only reachable with a real IBAN** → its extraction markers are coded from Achraf's screenshot 11 and live-verified at P6.

## Phase B — Extension

- [ ] **B1. Garanties controls** (commission 22 default, formule, fractionnement, comptant extraction) + wire into quote.preview/quote.confirm params. Unit tests. Commit `feat(extension): garanties closing controls`.
- [ ] **B2. devis.resume flow** + wire schemas + orchestrator gate + backend extension-client `resumeDevis` + control-plane `POST /devis-resume`. Commit.
- [ ] **B3. subscription.complete flow** (dryRun gate before Valider souscription; STOP at Paiement; IBAN masked logging) + `completeSubscription` + `POST /subscription`. Commit.
- [ ] **B4. contact-duplicate handling** in devis.fill-and-submit-mw (+ distinct error code). Commit.

## Phase C — Backend lifecycle

- [ ] **C1. Intents + dispatcher routing + DB migration** (quotes subscription fields, customers encrypted bank columns) + repo helpers + unit/DB-gated tests. Commit.
- [ ] **C2. Operator handleSubscriptionRequested** (gates, resume→complete, persist, emit SUBSCRIPTION.READY/FAILED, CONTRACT.PENDING_HUMAN escalation with screenshot to WA group + admin). Commit.
- [ ] **C3. Stripe integration** (client, frais computation 50/60/65 − comptant, link persisted + sent via sendViaChannel, feature-gated on STRIPE_SECRET_KEY). Commit.

## Phase D — Sales agent closing

- [ ] **D1. subscription.request tool** (IBAN mod-97 + masking, encrypted persistence, QUOTE.ACCEPTED + SUBSCRIPTION.REQUESTED) + SUBSCRIPTION.READY/FAILED handlers (templated French + payment link). Commit.
- [ ] **D2. Playbook closing phase + knowledge doc** (compliant reformulations only — no "taxe imposée par l'État"; fractionnement + frais explanation; collect IBAN/BIC/lieu de naissance; escalation triggers) + ingest registration. Commit.

## Phase E — Deploy + live verify (P6, with Achraf)

- [ ] **E1.** Build all, full test suite, push. Reload extension; `pnpm extension:ws`; restart backend ⚠️ only with Ridaa's go-live OK (channel-registry c55c848 flips WhatsApp customer-sends live on restart — separate decision).
- [ ] **E2.** Live: devis.resume on a real test devis → subscription dryRun (stops before Valider souscription) → comptant breakdown verified vs portal.
- [ ] **E3.** Supervised real souscription (Achraf + inspector aware; MAXANCE_SUBSCRIPTION_FORCE_DRYRUN lifted for one run): full flow to Paiement STOP → CONTRACT.PENDING_HUMAN lands in WA group with screenshot → Stripe link works → Achraf does the inspector handoff → CONTRACT.ISSUED resolved → lead closed_won + HubSpot gagne.
- [ ] **E4.** Store session learnings to ruflo + memory files; update milestone status.
