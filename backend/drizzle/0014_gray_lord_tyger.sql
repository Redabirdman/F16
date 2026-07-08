ALTER TABLE "leads" ADD COLUMN "followup_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followup_state" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followup_topic" text;--> statement-breakpoint
CREATE INDEX "leads_followup_due_idx" ON "leads" USING btree ("followup_state","followup_due_at");