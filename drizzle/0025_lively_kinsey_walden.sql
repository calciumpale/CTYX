CREATE TABLE `workbench_moment_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`request_key` text NOT NULL,
	`trigger` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`output_json` text NOT NULL,
	`next_check_at` text,
	`lease_token` text,
	`lease_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `workbench_moment_plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_moment_draft_request` ON `workbench_moment_drafts` (`owner_id`,`member_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `workbench_moment_draft_history` ON `workbench_moment_drafts` (`owner_id`,`member_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workbench_moment_draft_due` ON `workbench_moment_drafts` (`status`,`next_check_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `workbench_moment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`version` integer NOT NULL,
	`enabled` integer NOT NULL,
	`next_run_at` text,
	`archived_at` text,
	`updated_at` text NOT NULL,
	`input_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workbench_moment_plan_member` ON `workbench_moment_plans` (`owner_id`,`member_id`,`archived_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workbench_moment_plan_due` ON `workbench_moment_plans` (`enabled`,`archived_at`,`next_run_at`);