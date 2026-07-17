ALTER TABLE "codebuddy2api"."debug_logs" ADD COLUMN "elapsed_ms" integer;--> statement-breakpoint
ALTER TABLE "codebuddy2api"."debug_logs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "codebuddy2api"."debug_logs" ADD COLUMN "usage" jsonb;
