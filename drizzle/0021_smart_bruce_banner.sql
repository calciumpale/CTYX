CREATE TABLE `workbench_material_tasks` (
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
CREATE UNIQUE INDEX `workbench_material_identity` ON `workbench_material_tasks` (`owner_id`,`member_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `workbench_material_history` ON `workbench_material_tasks` (`owner_id`,`member_id`,`updated_at`);