// Schema barrel — exported into the drizzle client as `db.query.<table>`
// and consumed by drizzle-kit (see drizzle.config.ts) to generate migrations.
// Order is not significant; circular FKs are resolved by drizzle at build.
export * from './_enums.js';
export * from './customers.js';
export * from './leads.js';
export * from './conversation-turns.js';
