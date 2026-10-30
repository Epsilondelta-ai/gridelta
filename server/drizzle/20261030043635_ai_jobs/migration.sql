ALTER TABLE `ai_sessions` ADD `job_run_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `kind` text DEFAULT 'exec' NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `detail` text DEFAULT '' NOT NULL;