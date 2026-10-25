CREATE TABLE `workbench_recording_transcriptions` (
	`user_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`deal_id` text NOT NULL,
	`version` integer NOT NULL,
	`remote_id` text,
	`lease_until` text,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `recording_id`)
);
--> statement-breakpoint
CREATE INDEX `workbench_recording_transcription_project` ON `workbench_recording_transcriptions` (`user_id`,`deal_id`);--> statement-breakpoint
CREATE TABLE `workbench_speech_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	`data_json` text NOT NULL
);
