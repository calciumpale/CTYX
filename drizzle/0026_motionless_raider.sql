CREATE TABLE `workbench_creative_projects` (
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	`save_token` text NOT NULL,
	`document_json` text NOT NULL,
	PRIMARY KEY(`owner_id`, `member_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_creative_project_member` ON `workbench_creative_projects` (`owner_id`,`member_id`,`archived_at`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workbench_creative_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`boards_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_creative_template_project` ON `workbench_creative_templates` (`owner_id`,`member_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `workbench_creative_template_owner` ON `workbench_creative_templates` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workbench_creative_versions` (
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`document_json` text NOT NULL,
	PRIMARY KEY(`owner_id`, `member_id`, `project_id`, `version`)
);
