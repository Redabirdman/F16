/**
 * Assuryal customer-email template catalog (2026-07-03, Ridaa's request).
 *
 * Each builder returns the CARD BODY html (+ subject/preheader/cta) to be
 * wrapped by `renderBrandedEmail` — one visual identity, one place to edit
 * the wording per email type. Agents can send these through the email
 * channel by rendering to blocks, or the previews script can render them
 * to standalone HTML files for review.
 *
 * Tone rules: vouvoiement, first name capitalized, no chiffred delays, the
 * ONLY approved frais wordings (see playbook) — same compliance rules as
 * WhatsApp copy.
 */
import { renderBrandedEmail, escapeHtml } from './branding.js';

const VIOLET = '#5B3CF5';
const INK = '#221A4E';
const MUTED = '#6B668C';

export interface EmailTemplate {
  subject: string;
  preheader: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
}

function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function greeting(firstName?: string): string {
  return `<p style="margin:0 0 16px;font-size:16px;">Bonjour${
    firstName ? ` <strong>${escapeHtml(capFirst(firstName))}</strong>` : ''
  },</p>`;
}

function h(title: string): string {
  return `<h2 style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;color:${INK};">${escapeHtml(
    title,
  )}</h2>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 14px;">${text}</p>`;
}

/** Welcome — right after the lead comes in. */
export function welcomeTemplate(opts: { firstName?: string }): EmailTemplate {
  return {
    subject: 'Bienvenue chez Assuryal — votre demande est bien reçue',
    preheader: 'On prépare votre devis trottinette. Réponse rapide garantie.',
    bodyHtml: [
      h('Bienvenue chez Assuryal 👋'),
      greeting(opts.firstName),
      p(
        `Merci pour votre demande d'assurance trottinette électrique. Un conseiller Assuryal ` +
          `s'occupe de vous dès maintenant sur WhatsApp — quelques questions rapides et votre ` +
          `devis personnalisé arrive dans la foulée.`,
      ),
      p(
        `<strong>Bon à savoir :</strong> l'assurance responsabilité civile est obligatoire en France ` +
          `pour tous les engins de déplacement personnel motorisés (trottinettes, draisiennes…).`,
      ),
    ].join('\n'),
    cta: { label: 'Continuer sur WhatsApp', url: 'https://wa.me/212674009900' },
  };
}

/** Price menu — the 3 formules + options, mirrors the WhatsApp message. */
export function priceMenuTemplate(opts: {
  firstName?: string;
  lines: { label: string; monthly: string }[];
  options: { label: string; monthly: string; note: string }[];
  packMonthly?: string;
  firstPayment?: string;
  refShort: string;
}): EmailTemplate {
  const rows = opts.lines
    .map(
      (l) =>
        `<tr>
          <td style="padding:10px 14px;border-bottom:1px solid #EDEBFA;font-size:15px;color:${INK};">${escapeHtml(l.label)}</td>
          <td align="right" style="padding:10px 14px;border-bottom:1px solid #EDEBFA;font-size:15px;font-weight:bold;color:${VIOLET};white-space:nowrap;">${escapeHtml(l.monthly)}/mois</td>
        </tr>`,
    )
    .join('');
  const optRows = opts.options
    .map(
      (o) =>
        `<tr>
          <td style="padding:8px 14px;font-size:13px;color:${INK};">${escapeHtml(o.label)}<br/><span style="color:${MUTED};font-size:12px;">${escapeHtml(o.note)}</span></td>
          <td align="right" style="padding:8px 14px;font-size:14px;font-weight:bold;color:${INK};white-space:nowrap;">+${escapeHtml(o.monthly)}/mois</td>
        </tr>`,
    )
    .join('');
  return {
    subject: 'Vos tarifs Assuryal — assurance trottinette',
    preheader: `À partir de ${opts.lines[0]?.monthly ?? ''}/mois — formules et options.`,
    bodyHtml: [
      h('Vos tarifs trottinette'),
      greeting(opts.firstName),
      p('Voici vos mensualités, calculées sur votre profil :'),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #EDEBFA;border-radius:10px;overflow:hidden;margin:6px 0 18px;">${rows}</table>`,
      optRows
        ? `<p style="margin:0 0 6px;font-weight:bold;color:${INK};">Options ajoutables à toute formule</p>
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6FE;border-radius:10px;margin:0 0 18px;">${optRows}</table>`
        : '',
      opts.packMonthly
        ? p(
            `💡 <strong>Notre conseil :</strong> Tiers Illimité + les 2 options, soit environ ` +
              `<strong>${escapeHtml(opts.packMonthly)}/mois</strong> — la protection que choisissent la plupart de nos clients.`,
          )
        : '',
      opts.firstPayment
        ? p(
            `Premier paiement : <strong>${escapeHtml(opts.firstPayment)}</strong>, puis mensualités.`,
          )
        : '',
      `<p style="margin:16px 0 0;font-size:12px;color:${MUTED};">(réf #${escapeHtml(opts.refShort)})</p>`,
    ].join('\n'),
    cta: { label: 'Choisir ma formule sur WhatsApp', url: 'https://wa.me/212674009900' },
  };
}

/** Devis delivered — accompanies the PDF attachment. */
export function devisDeliveredTemplate(opts: {
  firstName?: string;
  devisNumber: string;
  withOptions?: boolean;
}): EmailTemplate {
  return {
    subject: `Votre devis Assuryal ${opts.devisNumber}`,
    preheader: 'Votre devis officiel est en pièce jointe.',
    bodyHtml: [
      h('Votre devis est prêt 📄'),
      greeting(opts.firstName),
      p(
        `Vous trouverez en pièce jointe votre devis officiel ` +
          `<strong>${escapeHtml(opts.devisNumber)}</strong>${
            opts.withOptions
              ? ' (avec les options Assistance Mobilité et Garantie Personnelle du Conducteur)'
              : ''
          }.`,
      ),
      p(
        `Si le devis vous convient, répondez simplement sur WhatsApp — la souscription se fait ` +
          `en quelques minutes. Et pour toute question, nous sommes là.`,
      ),
    ].join('\n'),
    cta: { label: 'Finaliser ma souscription', url: 'https://wa.me/212674009900' },
  };
}

/** Follow-up / relance — 24h-7d engagement nudges. */
export function followUpTemplate(opts: {
  firstName?: string;
  devisNumber?: string;
}): EmailTemplate {
  return {
    subject: 'Votre devis Assuryal vous attend',
    preheader: 'Toujours partant ? Votre tarif reste valable.',
    bodyHtml: [
      h('On garde votre place 🛴'),
      greeting(opts.firstName),
      p(
        opts.devisNumber
          ? `Votre devis <strong>${escapeHtml(opts.devisNumber)}</strong> est toujours disponible. ` +
              `Si vous avez la moindre question — garanties, options, paiement — répondez-nous sur WhatsApp, on vous répond tout de suite.`
          : `Votre demande d'assurance trottinette est toujours ouverte. Quelques questions suffisent pour recevoir votre devis personnalisé.`,
      ),
      p(
        `Pour rappel : rouler non assuré en trottinette électrique est sanctionné — et notre formule de base reste à petit prix.`,
      ),
    ].join('\n'),
    cta: { label: 'Reprendre la conversation', url: 'https://wa.me/212674009900' },
  };
}

/** Souscription — payment link for the frais d'inscription au contrat. */
export function subscriptionPaymentTemplate(opts: {
  firstName?: string;
  amount: string;
  paymentUrl: string;
}): EmailTemplate {
  return {
    subject: 'Votre souscription Assuryal — dernière étape',
    preheader: 'Réglez vos honoraires en quelques secondes, en toute sécurité.',
    bodyHtml: [
      h('Plus qu’une étape 🎉'),
      greeting(opts.firstName),
      p(
        `Votre souscription est presque finalisée. Pour activer votre contrat, il reste à régler ` +
          `vos honoraires d'accompagnement administratif : <strong>${escapeHtml(opts.amount)}</strong>.`,
      ),
      p(`Dès réception, votre contrat est débloqué et envoyé pour signature électronique.`),
    ].join('\n'),
    cta: { label: 'Payer en toute sécurité', url: opts.paymentUrl },
  };
}

/** Render any template to a full standalone HTML document. */
export function renderTemplate(t: EmailTemplate): string {
  return renderBrandedEmail({
    bodyHtml: t.bodyHtml,
    preheader: t.preheader,
    ...(t.cta ? { cta: t.cta } : {}),
  });
}
