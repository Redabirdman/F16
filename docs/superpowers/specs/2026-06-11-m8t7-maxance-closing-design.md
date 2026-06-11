# M8.T7 — Maxance Closing (souscription) — Design

Date: 2026-06-11. Source of truth: Achraf's `closing maxance.docx` (11 screenshots, frames of a 22:29 video) + scope locked by Ridaa (ruflo `m8t7-closing-SCOPE-LOCKED-2026-06-11`).

## 1. Goal & principle

Close the loop after the devis: when a customer accepts a quote, F16 autonomously **resumes the devis in Maxance, completes the souscription up to the Paiement page, collects the Assuryal frais via a Stripe payment link, and escalates the inspector handoff to a human** — then the contract is issued by Maxance and the lead closes won. The driver is the Chrome MV3 extension (LOCKED — never Playwright). DryRun-gated at every destructive step; the only fully-human steps are the inspector handoff and legal sign-offs.

## 2. Current state

- **Live today**: quote.preview (prices extracted from Garanties) → quote.confirm (devis form → DR number → Courrier email with PDF, 2-phase Envoyer→Valider) → self-healing tab reset (phase-2j).
- **Gaps this design closes**:
  - Garanties controls (`formule`, `commissionPct`, `fractionnement`) are accepted in params but **ignored** (`extension/src/flows/quote-preview.ts` — `void clampCommissionPct`). Achraf: commission must ALWAYS be 22% → today's quoted prices are at default commission and therefore wrong.
  - No reprise (resume) of an existing devis.
  - No souscription flow (Infos complémentaires → Coordonnées bancaires → Paiement).
  - No payment link, no inspector-handoff escalation, no closing conversation in the sales agent.
  - "Ce contact existe déjà" breaks the devis form for repeat customers (known issue, in scope per Ridaa).

## 3. The Maxance closing flow (from Achraf's doc)

1. **Garanties** (`souscriptionNaviguerOngletVehicule.do`, Garanties content): set commission slider **9% → 22%** (always); formule per client choice (Tiers Illimité / +Vol Incendie / Dommages tous accidents); fractionnement **Mensuel** (default) or **Annuel**; read Comptant / Terme suivant / Coût annuel brut. Then either **Valider devis** (existing path) or **Valider souscription** (closing path).
2. **Reprise du devis**: top ACCES PORTEFEUILLE search bar ← devis number → "Visualisation du devis" dossier page → **ACTION menu (top-left) → "Reprise du devis"** → lands on pre-filled Conducteur tab → **Suivant** through to Garanties/prices → Valider souscription.
3. **Infos complémentaires** tab: Nom/Prénom + **N° de série = "1234567" always** (placeholder; client mails real papers; Maxance handles) → Suivant.
4. **Coordonnées souscripteur + Coordonnées Bancaires de Prélèvement**: address prefilled; **Lieu de naissance Ville (if foreign → "Paris")**; IBAN (FR, segmented inputs) + BIC + Titulaire du compte; Date de prélèvement = 5. **Comptant à régler** block shows Frais de gestion + Commission + Frais de dossier = **Comptant dû** (e.g. 30.00 + 0.39 + 17.00 = 52.04 €, fractionnement Mensuel). Check **"Je dispose du comptant"** → Valider.
5. **Paiement page** (`souscriptionValiderFinaleMoto.do`): CB payment possible but **we never fill CB**. Preferred: client pays the Assuryal frais part via **payment link**; the comptant is prélevé on the 5th of next month.
6. **Inspector handoff (human)**: screenshot of the paiement/souscription state → Maxance inspector → "débloquer le contrat" → Maxance emails the contract for e-signature → memo provisoire under the contract's courrier icon. F16 escalates this via the human-action channel (admin + WA group) with the screenshot.

### Business rules (sales agent knowledge, not driver code)

- **Frais de dossier total**: 50 € (Tiers Illimité) / 60 € (+Vol Incendie) / 65 € (Dommages tous accidents). Maxance's "frais comptant" portion (read from the portal, e.g. 17 €) is the carrier's; **client pays Assuryal the remainder** (e.g. 33 €) at souscription via the payment link.
- First prélèvement = remaining frais + prorata of current month + mensualité.
- Framing: never announce "X € de frais de dossier" bluntly. **Compliant reformulations only** (Ridaa 2026-06-11): "frais d'inscription au contrat", "honoraires de gestion du dossier", "accompagnement administratif personnalisé". **"Taxe imposée par l'État" is DROPPED** (misrepresentation risk).
- Garanties additionnelles (Assistance Mobilité ~12.54, Garantie Personnelle Conducteur ~17.72) — agent must be able to explain them.
- Escalate to a human (responsable) whenever unsure — maps to `human.escalate`.

## 4. Extension design (workspace `extension/`)

New wire commands (Zod discriminated unions in `wire.ts`, registered in `content.ts`, orchestrated in `background.ts`):

### 4.1 Garanties controls (used by preview, confirm AND reprise)

New module `flows/garanties-controls.ts` exposing `applyGarantiesConfig({ formule, commissionPct, fractionnement })`:

- Commission: set the "Valeur commission (%)" control to `clampCommissionPct(commissionPct ?? 22)` via main-world dispatch (input + slider are framework widgets — live DOM survey required for exact mechanism), wait for the AJAX price re-render ("Chargement…" cleared).
- Formule: select the formule radio (left dot per screenshot 1) when ≠ already-selected; wait re-render.
- Fractionnement: `setSelectByLabel`-style change Mensuel/Annuel; wait re-render.
- Extract `comptantBreakdown`: Comptant, Terme suivant, Coût annuel brut + (clicking/inspecting the comptant detail if needed) frais de gestion / commission / frais de dossier figures.
- **quote.preview and quote.confirm now apply this config before price extraction** (default commissionPct 22) — corrects the quoted price.

### 4.2 `devis.resume` command

`{ id, kind:'devis.resume', devisNumber, formule?, commissionPct?, fractionnement?, timeoutMs? }`
Flow `flows/devis-resume.ts` (advance-loop + `.navigating` like preview/confirm):

1. From any Proximéo page: fill the top ACCES PORTEFEUILLE search input with `devisNumber` + GO (live survey for exact selectors; search criterion select if needed).
2. Detect "Visualisation du devis" page → open **ACTION** menu → click **Reprise du devis** (likely mdiWindNet/main-world).
3. Detect reprise Conducteur tab (`Reprise du devis n° DR…` marker) → click Suivant (`clickMaxanceButton('validerConducteur')` pattern) → Garanties.
4. Apply Garanties config (4.1), extract prices + comptant breakdown.
5. Return `devis.resume.ok { devisNumber, pricePreviewEur, comptantBreakdown, finalUrl, screenshots }`. Tab is left on Garanties, ready for `subscription.complete`. Self-healing: error → reset to accueil.do; success → NO reset (subscription needs the state).

### 4.3 `subscription.complete` command

`{ id, kind:'subscription.complete', devisNumber, subscriber:{ lastName, firstName }, bank:{ iban, bic, accountHolder }, birthPlaceCity, serialNumber?='1234567', dryRun=true, timeoutMs? }`
Flow `flows/subscription.ts`:

1. Pre-condition: Garanties page of the resumed devis (else error `maxance_subscription_wrong_state`).
2. **dryRun=true → STOP here** returning `subscription.complete.ok { dryRun:true, stoppedBefore:'valider_souscription', comptantBreakdown }`. The destructive gate is the **Valider souscription** click.
3. Real mode: click `#validerSouscription` (Garanties tab variant — the DESTRUCTIVE one, disambiguated by tab context per `reference_maxance_devis_widgets.md`).
4. **Infos complémentaires**: fill Nom/Prénom if empty, **N° de série = "1234567"**, Suivant.
5. **Coordonnées + bancaires**: Lieu de naissance Ville (param, "Paris" fallback for foreign); IBAN segmented inputs (split the IBAN string across the boxes — main-world fill), BIC, Titulaire du compte; verify Date de prélèvement=5 default; extract the **Comptant à régler** block figures; check **"Je dispose du comptant"**; `ErrorMessage()` check; click Valider.
6. **Paiement page**: detect `souscriptionValiderFinaleMoto.do` + "Encaissement relatif au souscripteur : T…" → extract souscripteur/instance ref + montant + the "email will be sent to <address>" line. **NEVER fill CB. STOP.** Screenshot for the inspector handoff.
7. Return `subscription.complete.ok { dryRun:false, souscripteurRef, montantComptant, comptantBreakdown, screenshots, finalUrl }`. Self-healing: error → reset; success → reset (paiement page is terminal; next flow starts clean).

- IBAN/BIC **never logged** in progress events (PII discipline) — log masked (`FR76 …1234`).

### 4.4 Repeat-customer "Ce contact existe déjà" (in `devis.fill-and-submit-mw`)

- After each Nouveau commit + after OK click: detect the Maxance alerte popin text. If it contains "contact existe déjà":
  - Dismiss the popin (main-world; survey the dismiss button).
  - Recovery: skip the Nouveau-commit for the offending widget when `contactList[0]` is already populated (existing contact case), re-fill Nom/Prénom/ligne1, retry OK once.
  - If still failing → distinct error `maxance_devis_contact_duplicate` (not the generic fill error) + self-healing reset, so the backend can reason about it (e.g. route to human or reuse-existing-contact strategy after live diagnosis).

### 4.5 Live DOM survey (pre-implementation)

Screenshots ≠ DOM. Before coding selectors for 4.2/4.3, run a read-only survey on the real portal via the Claude-in-Chrome MCP (established diagnostic practice): search-bar mechanics, ACTION menu structure, reprise URLs/markers, Infos complémentaires + bancaires field names, IBAN segmentation, "Je dispose du comptant" checkbox name, paiement page markers. Survey may click through reprise on a **test devis** but MUST NOT click Valider souscription.

## 5. Backend design (workspace `backend/`)

### 5.1 Intents + queues (`src/intents/subscription.ts`, dispatcher routing → 'quote' queue)

- `SUBSCRIPTION.REQUESTED` `{ quoteId, customerId, leadId, devisNumber, formule, fractionnement, bank{iban,bic,accountHolder}, birthPlaceCity }` — emitted by sales agent tool; consumed by maxance-operator.
- `SUBSCRIPTION.READY` `{ quoteId, customerId, souscripteurRef, montantComptant, comptantBreakdown, paymentLinkUrl }` — operator → sales agent (templated customer message + payment link send).
- `SUBSCRIPTION.FAILED` `{ quoteId, customerId, errorCode, detail?, screenshots }`.
- Reuse existing registered intents: `QUOTE.ACCEPTED` (sales agent emits when customer says yes), `CONTRACT.PENDING_HUMAN` (inspector handoff escalation), `CONTRACT.ISSUED` (human resolves → closed_won).

### 5.2 Maxance operator

- `extension-client.ts` + `driver-client.ts`: new methods `resumeDevis()` + `completeSubscription()` (same UUID-correlated pattern; 6-min timeout).
- `agent.ts`: `handleSubscriptionRequested` → driver gate → ensureLoggedIn → `resumeDevis` → `completeSubscription` (dryRun via `MAXANCE_SUBSCRIPTION_FORCE_DRYRUN`, default **'1' until P6 sign-off**) → persist → Stripe link → emit SUBSCRIPTION.READY → emit CONTRACT.PENDING_HUMAN with screenshot (human-action, severity 1, WA group + admin via reporter-agent image send).
- `control-plane.ts`: `POST /devis-resume`, `POST /subscription` (dryRun default true) for live verification.

### 5.3 DB

- `quotes`: add `subscription_status` ('none'|'requested'|'in_progress'|'pending_inspector'|'contract_issued'|'failed'), `souscripteur_ref`, `montant_comptant`, `frais_breakdown` (jsonb), `stripe_payment_link_url`, `subscription_at` timestamps. Status flow: accepted → (subscription) → closed.
- **Bank details (IBAN/BIC/holder): encrypted with the existing customers PII encryption** (same key/pattern as phone/email), new nullable encrypted columns on `customers`; never plaintext in logs/raw_response. Migration via drizzle-kit.
- Lead status: reuse `awaiting_payment` (payment link sent) → `closed_won` on CONTRACT.ISSUED. HubSpot: existing `attente_paiement` and `gagne` stages — **no new stages** (free tier, keep mapping stable); `emitHubSpotSync` on each transition (already wired via setLeadStatus + quote repo hooks).

### 5.4 Stripe (`src/integrations/stripe/`)

- Minimal client over the Stripe REST API (`STRIPE_SECRET_KEY` env, optional — feature-gated like channels bootstrap; `.env` via `scripts/update-env.ts`).
- `createFraisPaymentLink({ quoteId, formule, fraisComptantEur })`: amount = `FRAIS_DOSSIER_TOTAL[formule] (50/60/65 €) − fraisComptantEur(from portal)`, EUR, metadata `{quoteId, customerId}`. Returns URL persisted on the quote + sent to the customer via `sendViaChannel` (customer's channel) with compliant wording.
- Payment confirmation: V1 = human confirms via the existing human-action flow (webhook endpoint deferred — listed, not silently dropped: needs public tunnel route + signature verification; the stable tunnel exists, so it's a fast follow if Ridaa wants it now).

### 5.5 Sales agent (closing conversation)

- New tool `subscription.request` (parallel to `quote.request`): validates `{iban, bic, accountHolder, birthPlaceCity, formule, fractionnement}` (IBAN checksum validated in-code — mod-97 — satisfying Achraf's "verify the IBAN before filling"), persists encrypted bank details, emits QUOTE.ACCEPTED + SUBSCRIPTION.REQUESTED.
- Playbook closing phase (prompts fragment, admin-overridable): explain fractionnement/first-prélèvement, frais framing (compliant reformulations only), garanties additionnelles, collect IBAN/BIC/lieu de naissance conversationally (LLM reasoning, not forms/regex), call `subscription.request` when complete, escalate when unsure.
- `SUBSCRIPTION.READY` handler: templated French message (exact figures) + payment link.
- Knowledge: new markdown knowledge doc (Achraf's closing rules, compliant version) ingested via the markdownFileAdapter → `knowledge_chunks`; retrievable via `knowledge.search`. Works on WhatsApp AND voice (shared reply-core).
- Out of scope here (separately tracked): the global outcome-learning loop (sales_learnings distillation) — already a pending V1+ item.

## 6. Safety & gating

- Extension `subscription.complete` dryRun default **true**; backend `MAXANCE_SUBSCRIPTION_FORCE_DRYRUN` default **on** until P6 live sign-off with Achraf.
- The Valider souscription click is the destructive gate; the Paiement CB form is NEVER filled.
- Live souscription test: Achraf supervising, inspector aware (Ridaa OK 2026-06-11).
- IBAN/BIC: encrypted at rest, masked in logs/screenshots metadata, never in commits.

## 7. Testing

- Unit (vitest): wire schemas, IBAN mod-97 + masking, frais computation (50/60/65 − comptant), garanties config builder, intents payloads, Stripe client (mocked fetch), playbook fragments.
- DB-gated (f16_test on 5435 ONLY): migration, repo helpers, subscription status transitions.
- Live (P6, with Achraf): reprise on a real test devis → dryRun stop-before-Valider-souscription → supervised real run → inspector handoff escalation lands in WA group with screenshot → Stripe link opens.

## 8. Risks & mitigations

- **Unknown DOM for reprise/souscription pages** → mandatory live survey (4.5) before flow coding; diagnostics-first (form dumps) like phase-2d.
- **Commission slider mechanism unknown** (slider widget) → survey; fall back to setting the text input + change events; verify price re-render.
- **Valider souscription side-effects** (instance created in Maxance even if we stop at Paiement) → ask Achraf during P6 how to abandon/clean a test instance (Gestion des instances).
- **"Ce contact existe déjà" recovery** depends on live behavior → detection + skip-commit retry + distinct error code; iterate live.
- **Stripe key absent** → feature-gated; SUBSCRIPTION.READY still emitted with paymentLinkUrl null + human-action fallback mentioning manual link.
