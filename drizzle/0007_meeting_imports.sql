CREATE TABLE `workbench_meeting_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`authorized` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_meeting_device_token` ON `workbench_meeting_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `workbench_meeting_device_member` ON `workbench_meeting_devices` (`owner_id`,`member_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `workbench_meeting_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`deal_id` text NOT NULL,
	`source_key` text NOT NULL,
	`source_hash` text NOT NULL,
	`data_json` text NOT NULL,
	`linked` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_meeting_import_source` ON `workbench_meeting_imports` (`owner_id`,`deal_id`,`source_key`,`source_hash`);--> statement-breakpoint
CREATE INDEX `workbench_meeting_import_project` ON `workbench_meeting_imports` (`owner_id`,`deal_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workbench_meeting_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`device_id` text NOT NULL,
	`kind` text NOT NULL,
	`deal_id` text,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`active_key` text,
	`lease_hash` text,
	`lease_until` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`media_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_meeting_job_active` ON `workbench_meeting_jobs` (`active_key`);--> statement-breakpoint
CREATE INDEX `workbench_meeting_job_queue` ON `workbench_meeting_jobs` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `workbench_meeting_job_member` ON `workbench_meeting_jobs` (`owner_id`,`member_id`,`created_at`);