// drizzle-kit reads DATABASE_URL from the ambient environment. In dev/CI the URL
// is passed inline (`DATABASE_URL=... pnpm db:push`) or loaded by the runtime
// before invoking the kit (EasyPanel injects secrets). We deliberately do NOT
// pull dotenv-safe here: the repo uses `.env.template` (not `.env.example`) and
// applying full-env validation at tooling time fights with that convention.
// Runtime env validation is the backend's job (M2.T7), not drizzle-kit's.
import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required to run drizzle-kit. ' +
      'Pass it inline (e.g. `DATABASE_URL=postgres://... pnpm db:push`) ' +
      'or source it from your env manager before invoking the kit.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
});
