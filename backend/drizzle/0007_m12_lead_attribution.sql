CREATE TYPE "public"."lead_callback_state" AS ENUM('pending', 'dispatched', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lead_contact_window" AS ENUM('maintenant', 'matin', 'apres_midi', 'soir');--> statement-breakpoint
CREATE TYPE "public"."lead_preferred_channel" AS ENUM('whatsapp', 'call');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "meta_leadgen_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "attribution" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "preferred_channel" "lead_preferred_channel";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "preferred_time" "lead_contact_window";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "callback_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "callback_state" "lead_callback_state";--> statement-breakpoint
CREATE UNIQUE INDEX "leads_meta_leadgen_id_uniq" ON "leads" USING btree ("meta_leadgen_id");--> statement-breakpoint
CREATE INDEX "leads_callback_due_idx" ON "leads" USING btree ("callback_state","callback_due_at");