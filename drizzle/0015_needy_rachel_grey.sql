CREATE INDEX `workbench_prospect_campaign_discovery_due` ON `workbench_prospect_campaigns` (`owner_id`,`member_id`,`status`,json_extract(data_json, '$.dailyDiscovery.enabled'),json_extract(data_json, '$.dailyDiscovery.nextRunAt'));
--> statement-breakpoint
CREATE INDEX `workbench_prospect_job_discovery_run` ON `workbench_prospect_jobs` (json_extract(input_json, '$.discoveryRunId'),`status`,`kind`);
