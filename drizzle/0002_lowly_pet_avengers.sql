CREATE TABLE `workbench_talk_vectors` (
	`user_id` text NOT NULL,
	`track_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`title` text NOT NULL,
	`vector_json` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`metadata_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `track_id`, `content_hash`, `model`)
);
