CREATE TABLE "creative_learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"angle" text,
	"guidance" text NOT NULL,
	"source_feedback" text,
	"created_by_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "creative_learnings_angle_idx" ON "creative_learnings" USING btree ("angle");--> statement-breakpoint
CREATE INDEX "creative_learnings_created_at_idx" ON "creative_learnings" USING btree ("created_at" DESC);