CREATE TABLE `workbench_department_setups` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`manifest_hash` text NOT NULL,
	`before_state` text NOT NULL,
	`before_accounts` text NOT NULL,
	`result_json` text NOT NULL,
	`completed_at` text NOT NULL
);
