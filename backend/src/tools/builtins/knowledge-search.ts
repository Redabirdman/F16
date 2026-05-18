/**
 * Tool: `knowledge.search` — kNN search over the knowledge_chunks RAG corpus.
 *
 * The Service / Sales agents use this to ground replies in org-approved
 * material (pricing pages, FAQs, product catalogs). Returns the top-k chunks
 * ordered nearest-first (smallest cosine distance), with enough metadata for
 * the agent to cite the source.
 *
 * M7.T5: replaced the M3.T6 synthetic stub embedding with a real call to the
 * embedding client (OpenRouter-hosted `text-embedding-3-small`, 1536 dims, the
 * same model the corpus is indexed with). Test isolation is still possible —
 * `__setEmbeddingClientForTests` in `src/llm/embeddings.ts` lets unit tests
 * inject a deterministic stub so no network call is made.
 *
 * The Sales Agent allow-lists this tool, but is instructed (see
 * prompts/playbook.ts) to call it sparingly — once or twice per conversation
 * at most — because every invocation is an embedding round-trip.
 */
import { z } from 'zod';
import { registerTool } from '../registry.js';
import { searchSimilar } from '../../db/repositories/knowledge.js';
import { getDefaultEmbeddingClient } from '../../llm/embeddings.js';

export const knowledgeSearchToolName = 'knowledge.search';

const inputSchema = z.object({
  query: z.string().min(2),
  /** Max results to return. Default 5, capped to 20 to bound cost. */
  limit: z.number().int().positive().max(20).optional(),
});

const outputSchema = z.array(
  z.object({
    chunk: z.string(),
    source: z.string(),
    sourcePath: z.string().nullable(),
    distance: z.number(),
  }),
);

registerTool({
  name: knowledgeSearchToolName,
  description:
    'Recherche dans la base de connaissances Assuryal (produits, ' +
    'réglementation, FAQ, règles tarifaires) le contexte pertinent pour la ' +
    'question du client. Renvoie les chunks sémantiquement les plus proches ' +
    'avec leur source. À utiliser avec parcimonie — une ou deux fois par ' +
    'conversation, quand le client demande quelque chose de spécifique que tu ' +
    'ne sais pas déjà.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const limit = input.limit ?? 5;
    const ec = getDefaultEmbeddingClient();
    const queryEmbedding = await ec.embed(input.query);
    const hits = await searchSimilar(ctx.db, queryEmbedding, { limit });

    return hits.map((h) => ({
      chunk: h.chunk.chunkText,
      source: h.chunk.source,
      sourcePath: h.chunk.sourcePath,
      distance: h.distance,
    }));
  },
});
