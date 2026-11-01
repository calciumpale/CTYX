CREATE TABLE `workbench_business_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workbench_member_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`sales_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_iterations` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_member_owner_username` ON `workbench_member_accounts` (`owner_id`,`username`);--> statement-breakpoint
CREATE TABLE `workbench_member_login_limits` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workbench_member_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workbench_member_session_owner` ON `workbench_member_sessions` (`owner_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `workbench_member_session_expiry` ON `workbench_member_sessions` (`expires_at`);