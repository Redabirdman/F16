CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"agent_role" text,
	"purpose" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"iterations" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_usage_occurred_at_idx" ON "llm_usage" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "llm_usage_model_idx" ON "llm_usage" USING btree ("model");