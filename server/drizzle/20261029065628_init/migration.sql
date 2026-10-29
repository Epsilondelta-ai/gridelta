CREATE TABLE `endpoints` (
	`id` text PRIMARY KEY,
	`hostname` text NOT NULL,
	`os` text NOT NULL,
	`arch` text NOT NULL,
	`home_dir` text DEFAULT '' NOT NULL,
	`default_shell` text DEFAULT '' NOT NULL,
	`agent_version` text DEFAULT '' NOT NULL,
	`credential_hash` text NOT NULL,
	`enrolled_at` integer NOT NULL,
	`last_seen` integer,
	`revoked_at` integer,
	`labels` text DEFAULT '[]' NOT NULL,
	`approval_policy` text DEFAULT 'dangerous' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `enroll_tokens` (
	`token_hash` text PRIMARY KEY,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`username` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
