CREATE TYPE "public"."channel" AS ENUM('whatsapp', 'voice', 'email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."fact_type" AS ENUM('objection', 'preference', 'observation', 'event');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('website', 'meta', 'organic', 'referral', 'other');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'scored', 'qualifying', 'quoting', 'negotiating', 'awaiting_payment', 'closed_won', 'closed_lost', 'dormant');--> statement-breakpoint
CREATE TYPE "public"."product_line" AS ENUM('scooter', 'car');--> statement-breakpoint
CREATE TABLE "customer_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"fact_type" "fact_type" NOT NULL,
	"content" text NOT NULL,
	"confidence" real,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"iban_ciphertext" text,
	"iban_hash" varchar(43),
	"dob" date,
	"civility" text,
	"hubspot_id" text,
	"vehicle" jsonb,
	"driver" jsonb,
	"preferences" jsonb,
	"consent" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"source" "lead_source" NOT NULL,
	"source_id" text,
	"product_line" "product_line" NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"score" integer,
	"raw_payload" jsonb,
	"hubspot_deal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scored_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"lead_id" uuid,
	"channel" "channel" NOT NULL,
	"direction" "direction" NOT NULL,
	"agent_role" text,
	"agent_instance" text,
	"content" text NOT NULL,
	"attachments" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
ALTER TABLE "customer_facts" ADD CONSTRAINT "customer_facts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_facts_customer_id_idx" ON "customer_facts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_facts_embedding_idx" ON "customer_facts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "customers_iban_hash_uniq" ON "customers" USING btree ("iban_hash");--> statement-breakpoint
CREATE INDEX "customers_created_at_idx" ON "customers" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "customers_hubspot_id_idx" ON "customers" USING btree ("hubspot_id");--> statement-breakpoint
CREATE INDEX "leads_created_at_idx" ON "leads" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_customer_id_idx" ON "leads" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "conversation_turns_customer_id_idx" ON "conversation_turns" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "conversation_turns_lead_id_idx" ON "conversation_turns" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "conversation_turns_occurred_at_idx" ON "conversation_turns" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "conversation_turns_channel_idx" ON "conversation_turns" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "conversation_turns_embedding_idx" ON "conversation_turns" USING hnsw ("embedding" vector_cosine_ops);