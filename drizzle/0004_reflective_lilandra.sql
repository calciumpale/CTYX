CREATE TABLE `workbench_sales_coverage` (
	`user_id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workbench_sales_events` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_sales_event_day` ON `workbench_sales_events` (`user_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `workbench_sales_reports` (
	`user_id` text NOT NULL,
	`report_date` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `report_date`)
);
--> statement-breakpoint
CREATE INDEX `workbench_sales_report_updated` ON `workbench_sales_reports` (`user_id`,`updated_at`);