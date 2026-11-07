CREATE TABLE `workbench_prospect_contact_optouts` (
	`owner_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `sender_id`, `recipient_id`)
);
--> statement-breakpoint
ALTER TABLE `workbench_prospect_conversations` ADD `memory_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `workbench_prospect_conversations` ADD `close_reason` text;--> statement-breakpoint
ALTER TABLE `workbench_prospect_conversations` ADD `last_checked_at` text;