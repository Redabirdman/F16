CREATE TABLE "prompt_overrides" (
	"key" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
