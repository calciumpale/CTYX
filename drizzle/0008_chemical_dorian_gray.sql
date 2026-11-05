CREATE TABLE `workbench_prospect_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`status` text NOT NULL,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workbench_prospect_campaign_member` ON `workbench_prospect_campaigns` (`owner_id`,`member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`authenticated` integer DEFAULT 0 NOT NULL,
	`account_id` text,
	`account_name` text,
	`message` text,
	`last_seen_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_device_token` ON `workbench_prospect_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_device_member` ON `workbench_prospect_devices` (`owner_id`,`member_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`device_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`lead_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`active_key` text,
	`recipient_key` text,
	`sender_id` text,
	`lease_hash` text,
	`lease_until` text,
	`started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_job_active` ON `workbench_prospect_jobs` (`active_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_job_recipient` ON `workbench_prospect_jobs` (`recipient_key`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_job_queue` ON `workbench_prospect_jobs` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_job_sender` ON `workbench_prospect_jobs` (`owner_id`,`sender_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `workbench_prospect_leads` (
	`id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`job_id` text,
	`data_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_prospect_lead_member` ON `workbench_prospect_leads` (`owner_id`,`member_id`,`campaign_id`);