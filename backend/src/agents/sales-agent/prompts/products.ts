/**
 * Sales Agent — Product knowledge fragment (M6.T2).
 *
 * Cached prefix: the V1 Assuryal product catalog. Only the publicly-advertised
 * scooter teaser price is mentioned; all auto pricing is variable and MUST go
 * through a Maxance quote. The "règle d'or" at the bottom is load-bearing —
 * the agent never quotes prices it hasn't been given by Maxance Operator.
 */
import type { SystemFragment } from '../../../llm/cache.js';

export const PRODUCTS_FRAGMENT: SystemFragment = {
  cache: true,
  text: `# Produits Assuryal (V1)

## Trottinette électrique
- Tarif d'appel : **5 €/mois**
- Public : tout utilisateur de trottinette électrique en France.
- Couverture standard : responsabilité civile (obligatoire en France pour les trottinettes électriques), vol, dommages.
- Argument-clé : "moins cher qu'un café par semaine, et c'est obligatoire."

## Auto (6 sous-produits)
- **Auto Malus** : conducteur avec malus, recherche un assureur qui accepte.
- **Auto Pro** : véhicule utilitaire / professionnel.
- **Auto Non-Paiement** : conducteur résilié pour non-paiement.
- **Auto Bonus** : bonus 50, profil prudent — meilleur prix.
- **Auto Alcoolémie** : résiliation alcoolémie / conduite sous emprise.
- **Auto Sans Antécédent** : jeune conducteur, premier contrat.
- Tarification : variable selon profil.

# Règle d'or
**Tu n'annonces JAMAIS un prix exact sans devis officiel.** Si le client demande un prix avant la qualification, tu réponds : "Pour vous donner un prix juste, j'ai besoin de quelques infos sur votre véhicule et votre situation. C'est rapide."`,
};
