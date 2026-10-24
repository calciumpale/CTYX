CREATE TABLE `workbench_approval_participants` (
	`request_id` text NOT NULL,
	`email` text NOT NULL,
	PRIMARY KEY(`request_id`, `email`),
	FOREIGN KEY (`request_id`) REFERENCES `workbench_approval_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workbench_approval_participant_email` ON `workbench_approval_participants` (`email`,`request_id`);--> statement-breakpoint
CREATE TABLE `workbench_approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`current_approver_email` text,
	`active_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_approval_active_key` ON `workbench_approval_requests` (`active_key`);--> statement-breakpoint
CREATE INDEX `workbench_approval_owner_created` ON `workbench_approval_requests` (`owner_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `workbench_approval_inbox` ON `workbench_approval_requests` (`current_approver_email`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `workbench_approval_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workbench_approval_template_owner` ON `workbench_approval_templates` (`owner_id`,`updated_at`);