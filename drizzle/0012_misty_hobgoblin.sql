CREATE TABLE `workbench_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_owner_id` text NOT NULL,
	`owner_account_id` text NOT NULL,
	`owner_name` text NOT NULL,
	`request_id` text NOT NULL,
	`create_json` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`start_at` text,
	`end_at` text,
	`all_day` integer DEFAULT 0 NOT NULL,
	`deal_id` text,
	`location` text NOT NULL,
	`notes` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_schedule_retry` ON `workbench_schedules` (`workspace_owner_id`,`owner_account_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `workbench_schedule_calendar` ON `workbench_schedules` (`workspace_owner_id`,`owner_account_id`,`deleted_at`,`start_at`);--> statement-breakpoint
CREATE INDEX `workbench_schedule_team` ON `workbench_schedules` (`workspace_owner_id`,`deleted_at`,`start_at`);