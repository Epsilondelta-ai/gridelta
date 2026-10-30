CREATE TABLE `job_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`exit_code` integer,
	`error` text DEFAULT '' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`record_status` text DEFAULT 'none' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	CONSTRAINT `fk_job_results_run_id_job_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`trigger` text NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	`ran_count` integer DEFAULT 0 NOT NULL,
	`ai_session_id` text,
	CONSTRAINT `fk_job_runs_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`cron` text DEFAULT '' NOT NULL,
	`run_at` integer,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`command_unix` text DEFAULT '' NOT NULL,
	`command_windows` text DEFAULT '' NOT NULL,
	`ai_prompt` text DEFAULT '' NOT NULL,
	`record_name` text DEFAULT '' NOT NULL,
	`record_parse` text DEFAULT 'json' NOT NULL,
	`timeout_s` integer DEFAULT 600 NOT NULL,
	`concurrency` integer DEFAULT 10 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`created_by` text NOT NULL,
	`created_session` text DEFAULT '' NOT NULL,
	`approval_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `records` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`endpoint_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `records_endpoint_name_time` ON `records` (`endpoint_id`,`name`,`recorded_at`);