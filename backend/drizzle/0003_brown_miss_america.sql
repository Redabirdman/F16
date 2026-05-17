CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_role" text NOT NULL,
	"from_instance" text,
	"to_role" text NOT NULL,
	"to_instance" text,
	"intent" text NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" text,
	"requires_human" boolean DEFAULT false NOT NULL,
	"priority" smallint DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by" text,
	"result" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "agent_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_role" text NOT NULL,
	"pattern_type" text NOT NULL,
	"trigger_summary" text NOT NULL,
	"recommended_action" text NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"win_rate" real,
	"last_used_at" timestamp with time zone,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"meta" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_agent" text NOT NULL,
	"correlation_id" text,
	"intent" text NOT NULL,
	"severity" smallint NOT NULL,
	"summary" text NOT NULL,
	"options" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution" jsonb,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"escalated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"source_path" text,
	"chunk_text" text NOT NULL,
	"chunk_sha256" text NOT NULL,
	"token_count" integer,
	"embedding" vector(1536) NOT NULL,
	"meta" jsonb,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_messages_pending_by_role_idx" ON "agent_messages" USING btree ("to_role","consumed_at") WHERE "agent_messages"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_messages_correlation_idx" ON "agent_messages" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "agent_messages_created_at_idx" ON "agent_messages" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "agent_patterns_agent_role_idx" ON "agent_patterns" USING btree ("agent_role");--> statement-breakpoint
CREATE INDEX "agent_patterns_last_used_at_idx" ON "agent_patterns" USING btree ("last_used_at" DESC);--> statement-breakpoint
CREATE INDEX "agent_patterns_embedding_idx" ON "agent_patterns" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "human_actions_status_idx" ON "human_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "human_actions_severity_idx" ON "human_actions" USING btree ("severity" DESC);--> statement-breakpoint
CREATE INDEX "human_actions_due_at_idx" ON "human_actions" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "human_actions_correlation_idx" ON "human_actions" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "human_actions_created_at_idx" ON "human_actions" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_source_idx" ON "knowledge_chunks" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_chunk_sha256_uniq" ON "knowledge_chunks" USING btree ("chunk_sha256");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_source_path_idx" ON "knowledge_chunks" USING btree ("source","source_path");