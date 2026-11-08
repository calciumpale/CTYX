CREATE TABLE `workbench_knowledge_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`document_id` text NOT NULL,
	`request_id` text NOT NULL,
	`intent_hash` text NOT NULL,
	`base_version` integer NOT NULL,
	`config` text NOT NULL,
	`source_version` text NOT NULL,
	`source_hash` text NOT NULL,
	`source_length` integer NOT NULL,
	`file_name` text NOT NULL,
	`rebuild_index` integer NOT NULL,
	`model_key` text,
	`dimension` integer,
	`status` text NOT NULL,
	`token` text,
	`lease_until` text,
	`chunk_count` integer NOT NULL,
	`total_count` integer NOT NULL,
	`indexed_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `workbench_knowledge_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_knowledge_job_request` ON `workbench_knowledge_jobs` (`owner_id`,`document_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `workbench_knowledge_sources` (
	`owner_id` text NOT NULL,
	`document_id` text NOT NULL,
	`version` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`hash` text NOT NULL,
	`length` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `document_id`, `version`, `ordinal`),
	FOREIGN KEY (`document_id`) REFERENCES `workbench_knowledge_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workbench_knowledge_staging` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`parent_ordinal` integer,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`heading` text NOT NULL,
	`tokens` text NOT NULL,
	`vector_json` text,
	`vector_model` text,
	FOREIGN KEY (`job_id`) REFERENCES `workbench_knowledge_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_knowledge_stage_order` ON `workbench_knowledge_staging` (`owner_id`,`job_id`,`ordinal`);--> statement-breakpoint
ALTER TABLE `workbench_knowledge_documents` ADD `content_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_documents` ADD `source_version` text;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_documents` ADD `source_hash` text;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_documents` ADD `applied_config` text;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_documents` ADD `upload_request_id` text;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_documents` ADD `upload_hash` text;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_documents` ADD `current_rechunk_job_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_knowledge_upload_request` ON `workbench_knowledge_documents` (`owner_id`,`upload_request_id`);--> statement-breakpoint
ALTER TABLE `workbench_knowledge_libraries` ADD `default_config` text;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_libraries` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workbench_knowledge_libraries` ADD `department_id` text DEFAULT 'shared' NOT NULL;
--> statement-breakpoint
UPDATE workbench_knowledge_libraries SET department_id=CASE trim(name) WHEN '招商' THEN 'zs' WHEN '医药' THEN 'yy' WHEN '园林' THEN 'yl' WHEN '测绘' THEN 'ch' WHEN '文旅' THEN 'wl' WHEN '话术' THEN 'shared' ELSE 'unassigned' END;
