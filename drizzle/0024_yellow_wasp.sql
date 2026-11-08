CREATE TABLE `workbench_digital_human_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_dh_asset_identity` ON `workbench_digital_human_assets` (`owner_id`,`member_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `workbench_dh_asset_history` ON `workbench_digital_human_assets` (`owner_id`,`member_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workbench_digital_human_lives` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_dh_live_identity` ON `workbench_digital_human_lives` (`owner_id`,`member_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `workbench_dh_live_history` ON `workbench_digital_human_lives` (`owner_id`,`member_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workbench_digital_human_operations` (
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`request_id` text NOT NULL,
	`live_id` text NOT NULL,
	`action` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`owner_id`, `member_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_dh_operation_live` ON `workbench_digital_human_operations` (`owner_id`,`member_id`,`live_id`);