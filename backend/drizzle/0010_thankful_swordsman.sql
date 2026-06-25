ALTER TABLE "customers" ADD COLUMN "bank_iban_enc" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "bank_bic_enc" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "bank_account_holder_enc" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "birth_place_city" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "subscription_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "souscripteur_ref" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "montant_comptant" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "frais_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "stripe_payment_link_url" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "subscription_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "subscription_completed_at" timestamp with time zone;