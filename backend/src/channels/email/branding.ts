/**
 * Assuryal branded email shell (2026-07-03, Ridaa's request).
 *
 * EVERY customer email now renders inside this shell — welcome, price
 * menu, devis delivery, relances, souscription — so a plain text block
 * from any agent arrives looking like the brand, not like a bare SMTP
 * test. The palette comes from the live site (conversion-machine-main
 * src/index.css): deep navy #1A0840 / #120530, violet #5B3CF5, logo
 * purple #7B5CF6, light #EEEEFF.
 *
 * Email-client constraints honoured:
 *   - table-based layout, max 600px, fluid on mobile;
 *   - ALL styles inline (Gmail strips <style> in some contexts; we keep a
 *     minimal <style> only for dark-mode hints and link colors);
 *   - text wordmark instead of a remote logo image (remote images are
 *     blocked by default in most clients; the header must still look
 *     branded with images off);
 *   - preheader hidden-text pattern for the inbox preview line.
 */

const NAVY = '#1A0840';
const NAVY_DEEP = '#120530';
const VIOLET = '#5B3CF5';
const LIGHT = '#EEEEFF';
const INK = '#221A4E';
const MUTED = '#6B668C';

export interface BrandedEmailOptions {
  /** Pre-rendered inner HTML (paragraphs, lists — already escaped). */
  bodyHtml: string;
  /** Inbox preview line (hidden in the body). Defaults to empty. */
  preheader?: string;
  /** Optional call-to-action button appended after the body. */
  cta?: { label: string; url: string };
}

/** Render the full branded HTML document around a body fragment. */
export function renderBrandedEmail(opts: BrandedEmailOptions): string {
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(
        opts.preheader,
      )}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : '';
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 4px;">
        <tr><td style="border-radius:10px;background:${VIOLET};">
          <a href="${escapeAttr(opts.cta.url)}"
             style="display:inline-block;padding:13px 34px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:10px;">
            ${escapeHtml(opts.cta.label)}</a>
        </td></tr></table>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<style>
  a { color: ${VIOLET}; }
  @media only screen and (max-width: 620px) { .container { width: 100% !important; } .content { padding: 24px 20px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:${LIGHT};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT};padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,${NAVY} 0%,${NAVY_DEEP} 100%);background-color:${NAVY};border-radius:14px 14px 0 0;padding:26px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:800;letter-spacing:3px;color:#FFFFFF;">
            ASSURYAL<span style="color:#7B5CF6;">.</span>
          </td>
          <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#B9B3E8;text-transform:uppercase;">
            Assurance mobilité
          </td>
        </tr></table>
      </td></tr>

      <!-- Accent bar -->
      <tr><td style="height:4px;background:${VIOLET};font-size:0;line-height:0;">&nbsp;</td></tr>

      <!-- Content card -->
      <tr><td class="content" style="background:#FFFFFF;padding:32px 36px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:${INK};">
        ${opts.bodyHtml}
        ${cta}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#FFFFFF;border-radius:0 0 14px 14px;border-top:1px solid #E8E5F7;padding:20px 36px 26px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:${MUTED};">
        <strong style="color:${INK};">Assuryal</strong> — votre courtier assurance mobilité<br/>
        <a href="https://assuryalconseil.fr" style="color:${VIOLET};text-decoration:none;">assuryalconseil.fr</a>
        &nbsp;·&nbsp; <a href="mailto:contact@assuryalconseil.fr" style="color:${VIOLET};text-decoration:none;">contact@assuryalconseil.fr</a><br/>
        <span style="font-size:11px;color:#9A95BE;">Vous recevez cet email dans le cadre de votre demande de devis ou de votre contrat Assuryal.</span>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s);
}
