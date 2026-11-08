CREATE TABLE `workbench_prospect_discovery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`daily_key` text,
	`scheduled_for` text NOT NULL,
	`status` text NOT NULL,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_prospect_discovery_daily` ON `workbench_prospect_discovery_runs` (`campaign_id`,`daily_key`);--> statement-breakpoint
CREATE INDEX `workbench_prospect_discovery_member` ON `workbench_prospect_discovery_runs` (`owner_id`,`member_id`,`campaign_id`,`created_at`);