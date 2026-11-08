ALTER TABLE `workbench_prospect_memory_sessions` ADD `source_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workbench_prospect_memory_sources` ADD `processed_status` text;--> statement-breakpoint
CREATE TRIGGER prospect_memory_source_insert AFTER INSERT ON workbench_prospect_memory_sources BEGIN
 UPDATE workbench_prospect_memory_sessions SET source_version=source_version+1 WHERE id=NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER prospect_memory_message_status AFTER UPDATE OF status,job_id,text ON workbench_prospect_messages BEGIN
 UPDATE workbench_prospect_memory_sessions SET source_version=source_version+1 WHERE id IN (SELECT session_id FROM workbench_prospect_memory_sources WHERE message_id=NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER prospect_memory_job_status AFTER UPDATE OF status,result_json ON workbench_prospect_jobs BEGIN
 UPDATE workbench_prospect_memory_sessions SET source_version=source_version+1 WHERE id IN (SELECT x.session_id FROM workbench_prospect_memory_sources x JOIN workbench_prospect_messages m ON m.id=x.message_id WHERE m.job_id=NEW.id);
END;
