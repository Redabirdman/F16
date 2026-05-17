/**
 * Tool: `knowledge.search` — kNN search over the knowledge_chunks RAG corpus.
 *
 * The Service / Sales agents use this to ground replies in org-approved
 * material (pricing pages, FAQs, product catalogs). Returns the top-k chunks
 * ordered nearest-first (smallest cosine distance), with enough metadata for
 * the agent to cite the source.
 *
 * STUB EMBEDDING (M3.T6 → M7):
 *   Until M7 wires real query embeddings through the embedding provider, this
 *   tool uses a fixed synthetic query vector (Array(1536).fill(0.001)). That
 *   makes the tool exercisable from tests with seeded data (the test seeds
 *   chunks with known vectors and the cosine distance to the stub is
 *   predictable), but it is NOT useful in production yet. The description
 *   below makes that explicit so an agent reading its own toolset knows the
 *   limitation.
 */
import { z } from 'zod';
import { registerTool } from '../registry.js';
import { searchSimilar } from '../../db/repositories/knowledge.js';

export const knowledgeSearchToolName = 'knowledge.search';

const inputSchema = z.object({
  query: z.string().min(1),
  /** Max results to return. Default 5, capped to 50 to bound cost. */
  limit: z.number().int().positive().max(50).optional(),
});

const outputSchema = z.array(
  z.object({
    chunk: z.string(),
    source: z.string(),
    sourcePath: z.string().nullable(),
    distance: z.number(),
  }),
);

/** Stub query embedding used until M7. See file header for rationale. */
const STUB_QUERY_EMBEDDING: number[] = new Array<number>(1536).fill(0.001);

registerTool({
  name: knowledgeSearchToolName,
  description:
    'Search the organisation knowledge corpus (pricing, FAQs, catalogs) by ' +
    'natural-language query. Returns the top-k most-similar chunks with ' +
    'source attribution. NOTE: currently uses a stub query embedding; real ' +
    'embedding-based lookup arrives in M7.',
  inputSchema,
  outputSchema,
  handler: async (ctx, input) => {
    const limit = input.limit ?? 5;
    // input.query is intentionally NOT yet embedded — see file header.
    void input.query;
    const hits = await searchSimilar(ctx.db, STUB_QUERY_EMBEDDING, { limit });

    return hits.map((h) => ({
      chunk: h.chunk.chunkText,
      source: h.chunk.source,
      sourcePath: h.chunk.sourcePath,
      distance: h.distance,
    }));
  },
});
