CREATE TABLE `workbench_knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`document_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`parent_ordinal` integer,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`heading` text NOT NULL,
	`vector_json` text,
	`vector_model` text,
	FOREIGN KEY (`document_id`) REFERENCES `workbench_knowledge_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workbench_knowledge_chunk_order` ON `workbench_knowledge_chunks` (`owner_id`,`document_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `workbench_knowledge_chunk_model` ON `workbench_knowledge_chunks` (`owner_id`,`vector_model`);--> statement-breakpoint
CREATE TABLE `workbench_knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`library_id` text NOT NULL,
	`title` text NOT NULL,
	`file_name` text NOT NULL,
	`strategy` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`chunk_count` integer NOT NULL,
	`indexed_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`model_key` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`dimension` integer,
	`index_token` text,
	`index_until` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `workbench_knowledge_libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workbench_knowledge_document_owner` ON `workbench_knowledge_documents` (`owner_id`,`library_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workbench_knowledge_libraries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workbench_knowledge_library_owner` ON `workbench_knowledge_libraries` (`owner_id`,`created_at`);
--> statement-breakpoint
-- Terms are pretokenized by the shared Chinese/identifier tokenizer before FTS5 indexing.
CREATE VIRTUAL TABLE `workbench_knowledge_fts` USING fts5(chunk_id UNINDEXED, owner_id UNINDEXED, tokens, tokenize='unicode61');
