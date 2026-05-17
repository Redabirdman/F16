CREATE TYPE "public"."agent_status" AS ENUM('starting', 'running', 'stopping', 'stopped', 'crashed');--> statement-breakpoint
CREATE TABLE "agents_state" (
	"role" text NOT NULL,
	"instance_id" text NOT NULL,
	"model" text NOT NULL,
	"queue" text NOT NULL,
	"status" "agent_status" NOT NULL,
	"meta" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "agents_state_role_instance_id_pk" PRIMARY KEY("role","instance_id")
);
--> statement-breakpoint
CREATE INDEX "agents_state_status_idx" ON "agents_state" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_state_role_idx" ON "agents_state" USING btree ("role");--> statement-breakpoint
CREATE INDEX "agents_state_last_heartbeat_idx" ON "agents_state" USING btree ("last_heartbeat_at" DESC);