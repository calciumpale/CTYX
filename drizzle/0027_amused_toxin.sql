CREATE TABLE `workbench_geo_projects` (
	`owner_id` text NOT NULL,
	`member_id` text NOT NULL,
	`id` text NOT NULL,
	`topic` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`document_json` text NOT NULL,
	`review_note` text NOT NULL,
	`reviewer_id` text,
	`reviewed_at` text,
	`publication_json` text,
	`observations_json` text NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_geo_author` ON `workbench_geo_projects` (`owner_id`,`member_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workbench_geo_review_queue` ON `workbench_geo_projects` (`owner_id`,`status`,`updated_at`);