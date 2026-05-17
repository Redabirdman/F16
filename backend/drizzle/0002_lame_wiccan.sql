CREATE TABLE "ad_metrics_hourly" (
	"ad_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"ctr" real,
	"conversions" integer DEFAULT 0 NOT NULL,
	"cost_per_conversion_cents" integer,
	"spend_cents" bigint DEFAULT 0 NOT NULL,
	"frequency" real,
	"reach" integer,
	"raw_meta_payload" jsonb,
	CONSTRAINT "ad_metrics_hourly_pkey" PRIMARY KEY("ad_id","captured_at")
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adset_id" uuid NOT NULL,
	"creative_id" uuid,
	"meta_ad_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text,
	"primary_text" text,
	"headline" text,
	"description" text,
	"cta_type" text,
	"fatigue_score" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_meta_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "adsets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"meta_adset_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text,
	"targeting" jsonb,
	"daily_budget_cents" bigint,
	"lifetime_budget_cents" bigint,
	"optimization_goal" text,
	"billing_event" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_meta_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meta_campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"objective" text,
	"status" text,
	"product_line" "product_line",
	"daily_budget_cents" bigint,
	"lifetime_budget_cents" bigint,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"raw_meta_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"angle" text NOT NULL,
	"product_line" "product_line",
	"format" text NOT NULL,
	"headline" text,
	"sub_copy" text,
	"cta_text" text,
	"file_url" text NOT NULL,
	"file_sha256" text NOT NULL,
	"generation_prompt" text,
	"generation_meta" jsonb,
	"generated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_metrics_hourly" ADD CONSTRAINT "ad_metrics_hourly_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_adset_id_adsets_id_fk" FOREIGN KEY ("adset_id") REFERENCES "public"."adsets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adsets" ADD CONSTRAINT "adsets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_metrics_hourly_captured_at_idx" ON "ad_metrics_hourly" USING btree ("captured_at" DESC);--> statement-breakpoint
CREATE INDEX "ads_adset_id_idx" ON "ads" USING btree ("adset_id");--> statement-breakpoint
CREATE INDEX "ads_creative_id_idx" ON "ads" USING btree ("creative_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ads_meta_ad_id_uniq" ON "ads" USING btree ("meta_ad_id");--> statement-breakpoint
CREATE INDEX "ads_status_idx" ON "ads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ads_fatigue_score_idx" ON "ads" USING btree ("fatigue_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "adsets_campaign_id_idx" ON "adsets" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "adsets_meta_adset_id_uniq" ON "adsets" USING btree ("meta_adset_id");--> statement-breakpoint
CREATE INDEX "adsets_status_idx" ON "adsets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_meta_campaign_id_uniq" ON "campaigns" USING btree ("meta_campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_product_line_idx" ON "campaigns" USING btree ("product_line");--> statement-breakpoint
CREATE INDEX "campaigns_created_at_idx" ON "campaigns" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "creatives_product_line_angle_idx" ON "creatives" USING btree ("product_line","angle");--> statement-breakpoint
CREATE INDEX "creatives_format_idx" ON "creatives" USING btree ("format");--> statement-breakpoint
CREATE UNIQUE INDEX "creatives_file_sha256_uniq" ON "creatives" USING btree ("file_sha256");--> statement-breakpoint
CREATE INDEX "creatives_generated_by_idx" ON "creatives" USING btree ("generated_by");