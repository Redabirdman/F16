/**
 * Render every Assuryal email template to var/email-previews/*.html for
 * visual review in a browser (2026-07-03). Usage:
 *   npx tsx scripts/email-previews.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  welcomeTemplate,
  priceMenuTemplate,
  devisDeliveredTemplate,
  followUpTemplate,
  subscriptionPaymentTemplate,
  renderTemplate,
} from '../src/channels/email/templates.js';

const OUT = join(import.meta.dirname, '..', 'var', 'email-previews');
await mkdir(OUT, { recursive: true });

const previews = {
  '1-welcome': welcomeTemplate({ firstName: 'achraf' }),
  '2-price-menu': priceMenuTemplate({
    firstName: 'achraf',
    lines: [
      { label: 'Tiers Illimité', monthly: '7,97 €' },
      { label: 'Tiers Illimité + Vol & Incendie', monthly: '15,15 €' },
      { label: 'Tous Risques', monthly: '22,14 €' },
    ],
    options: [
      {
        label: 'Assistance Mobilité',
        monthly: '1,09 €',
        note: 'dépannage pris en charge quoi qu’il arrive',
      },
      {
        label: 'Garantie Personnelle du Conducteur',
        monthly: '1,48 €',
        note: 'soins/hôpital même si vous êtes responsable',
      },
    ],
    packMonthly: '10,54 €',
    firstPayment: '23,65 €',
    refShort: '3c9b91da',
  }),
  '3-devis-delivered': devisDeliveredTemplate({
    firstName: 'achraf',
    devisNumber: 'DR0000983704',
    withOptions: true,
  }),
  '4-follow-up': followUpTemplate({ firstName: 'achraf', devisNumber: 'DR0000983704' }),
  '5-subscription-payment': subscriptionPaymentTemplate({
    firstName: 'achraf',
    amount: '17,00 €',
    paymentUrl: 'https://buy.stripe.com/example',
  }),
};

for (const [name, tpl] of Object.entries(previews)) {
  const file = join(OUT, `${name}.html`);
  await writeFile(file, renderTemplate(tpl), 'utf8');
  console.log('wrote', file);
}
console.log('\nOpen the folder to review:', OUT);
