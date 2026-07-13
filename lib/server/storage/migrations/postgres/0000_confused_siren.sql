CREATE SCHEMA IF NOT EXISTS "codebuddy2api";
--> statement-breakpoint
CREATE TABLE "codebuddy2api"."debug_logs" (
	"event_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"credential_filename" text,
	"error" text,
	"request_key" text,
	"route" text NOT NULL,
	"request_body" jsonb,
	"transformed_response" jsonb,
	"upstream_request" jsonb,
	"upstream_response" jsonb
);
--> statement-breakpoint
CREATE TABLE "codebuddy2api"."documents" (
	"namespace" text NOT NULL,
	"document_key" text NOT NULL,
	"payload" jsonb,
	"encrypted_payload" text,
	"encryption_mode" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_namespace_document_key_pk" PRIMARY KEY("namespace","document_key")
);
--> statement-breakpoint
CREATE TABLE "codebuddy2api"."usage_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"access_key_id" text,
	"access_key_name" text,
	"cache_creation_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"call_count" integer NOT NULL,
	"credential_filename" text,
	"input_tokens" integer NOT NULL,
	"model" text NOT NULL,
	"output_tokens" integer NOT NULL,
	"route" text NOT NULL,
	"total_tokens" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "debug_logs_created_at_idx" ON "codebuddy2api"."debug_logs" USING btree ("created_at" DESC NULLS LAST,"event_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_events_occurred_at_idx" ON "codebuddy2api"."usage_events" USING btree ("occurred_at","event_id");--> statement-breakpoint
CREATE INDEX "usage_events_credential_occurred_at_idx" ON "codebuddy2api"."usage_events" USING btree ("credential_filename","occurred_at","event_id");--> statement-breakpoint
CREATE INDEX "usage_events_access_key_occurred_at_idx" ON "codebuddy2api"."usage_events" USING btree ("access_key_id","occurred_at","event_id");
