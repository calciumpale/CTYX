CREATE TABLE `workbench_web_prospect_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`task_id` text NOT NULL,
	`source_url` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`project_id` text,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_web_lead_url` ON `workbench_web_prospect_leads` (`owner_id`,`member_id`,`source_url`);--> statement-breakpoint
CREATE INDEX `workbench_web_lead_member` ON `workbench_web_prospect_leads` (`owner_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `workbench_web_prospect_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_web_task_retry` ON `workbench_web_prospect_tasks` (`owner_id`,`member_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `workbench_web_task_history` ON `workbench_web_prospect_tasks` (`owner_id`,`member_id`,`created_at`);