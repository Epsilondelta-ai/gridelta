CREATE TABLE `ai_sessions` (
	`id` text PRIMARY KEY,
	`scope` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
