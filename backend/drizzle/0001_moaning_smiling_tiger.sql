CREATE TYPE "public"."quote_status" AS ENUM('draft', 'requested', 'in_progress', 'ready', 'sent', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "maxance_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"action_text" text NOT NULL,
	"step_index" integer NOT NULL,
	"step_name" text,
	"screenshot_before_url" text,
	"screenshot_after_url" text,
	"duration_ms" integer,
	"result" jsonb,
	"error" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"lead_id" uuid,
	"product" "product_line" NOT NULL,
	"product_variant" text NOT NULL,
	"status" "quote_status" DEFAULT 'requested' NOT NULL,
	"monthly_premium" numeric(10, 2),
	"comptant_due" numeric(10, 2),
	"maxance_devis_number" text,
	"pdf_url" text,
	"session_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"raw_form_data" jsonb,
	"raw_response" jsonb
);
--> statement-breakpoint
ALTER TABLE "maxance_actions" ADD CONSTRAINT "maxance_actions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "maxance_actions_quote_step_uniq" ON "maxance_actions" USING btree ("quote_id","step_index");--> statement-breakpoint
CREATE INDEX "maxance_actions_session_id_idx" ON "maxance_actions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "maxance_actions_occurred_at_idx" ON "maxance_actions" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "quotes_customer_id_idx" ON "quotes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "quotes_lead_id_idx" ON "quotes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "quotes_status_idx" ON "quotes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_session_id_uniq" ON "quotes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "quotes_requested_at_idx" ON "quotes" USING btree ("requested_at" DESC);