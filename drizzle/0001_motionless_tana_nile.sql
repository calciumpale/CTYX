CREATE TABLE `workbench_api_connections` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`base_url` text NOT NULL,
	`model_name` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `kind`)
);
