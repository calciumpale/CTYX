CREATE TABLE `workbench_prospect_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`profile_url` text NOT NULL,
	`nickname` text NOT NULL,
	`mode` text DEFAULT 'agent' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`opened_at` text NOT NULL,
	`last_read_at` text,
	`last_snapshot_id` text,
	`has_baseline` integer DEFAULT 0 NOT NULL,
	`last_message_at` text NOT NULL,
	`last_message_preview` text DEFAULT '' NOT NULL,
	`handoff_reason` text,
	`processing_token` text,
	`processing_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_conversation_contact` ON `workbench_prospect_conversations` (`owner_id`,`sender_id`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_conversation_member` ON `workbench_prospect_conversations` (`owner_id`,`member_id`,`campaign_id`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_lead_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`contact_key` text NOT NULL,
	`contact_type` text NOT NULL,
	`contact_value` text NOT NULL,
	`nickname` text NOT NULL,
	`score` integer NOT NULL,
	`grade` text NOT NULL,
	`reason` text NOT NULL,
	`assigned_member_id` text,
	`assigned_name` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_pool_contact` ON `workbench_prospect_lead_pool` (`owner_id`,`conversation_id`,`contact_key`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_pool_assignee` ON `workbench_prospect_lead_pool` (`owner_id`,`assigned_member_id`,`status`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`source_key` text NOT NULL,
	`direction` text NOT NULL,
	`actor` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`posted_at` text,
	`created_at` text NOT NULL,
	`error` text,
	`job_id` text,
	`eligible` integer DEFAULT 0 NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_message_source` ON `workbench_prospect_messages` (`conversation_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_message_thread` ON `workbench_prospect_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_message_pending` ON `workbench_prospect_messages` (`owner_id`,`member_id`,`eligible`,`processed`);