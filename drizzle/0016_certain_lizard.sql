CREATE TABLE `workbench_prospect_memory_bindings` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`active_session_id` text NOT NULL,
	`original_session_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`legacy_watermark` integer DEFAULT 0 NOT NULL,
	`switched_watermark` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workbench_prospect_memory_captures` (
	`session_id` text NOT NULL,
	`capture_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `capture_id`)
);
--> statement-breakpoint
CREATE TABLE `workbench_prospect_memory_events` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`created_at` text NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`session_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_prospect_memory_event_time` ON `workbench_prospect_memory_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_memory_facts` (
	`session_id` text NOT NULL,
	`id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`status` text NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`session_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_prospect_memory_fact_source` ON `workbench_prospect_memory_facts` (`session_id`,`source_message_id`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_memory_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`source_watermark` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`write_token` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_memory_task` ON `workbench_prospect_memory_sessions` (`thread_id`,`campaign_id`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_memory_member` ON `workbench_prospect_memory_sessions` (`owner_id`,`member_id`,`campaign_id`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_memory_sources` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`binding_version` integer NOT NULL,
	`row_order` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workbench_prospect_memory_source_session` ON `workbench_prospect_memory_sources` (`session_id`,`row_order`);