CREATE TABLE `debug_logs` (
	`event_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`credential_filename` text,
	`error` text,
	`request_key` text,
	`route` text NOT NULL,
	`request_body` text,
	`transformed_response` text,
	`upstream_request` text,
	`upstream_response` text
);
--> statement-breakpoint
CREATE INDEX `debug_logs_created_at_idx` ON `debug_logs` (`created_at`,`event_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`namespace` text NOT NULL,
	`document_key` text NOT NULL,
	`payload` text,
	`encrypted_payload` text,
	`encryption_mode` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`namespace`, `document_key`)
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`access_key_id` text,
	`access_key_name` text,
	`cache_creation_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`call_count` integer NOT NULL,
	`credential_filename` text,
	`input_tokens` integer NOT NULL,
	`model` text NOT NULL,
	`output_tokens` integer NOT NULL,
	`route` text NOT NULL,
	`total_tokens` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_events_occurred_at_idx` ON `usage_events` (`occurred_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `usage_events_credential_occurred_at_idx` ON `usage_events` (`credential_filename`,`occurred_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `usage_events_access_key_occurred_at_idx` ON `usage_events` (`access_key_id`,`occurred_at`,`event_id`);