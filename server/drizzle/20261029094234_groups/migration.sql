CREATE TABLE `groups` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `endpoints` ADD `group_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `enroll_tokens` ADD `group_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `enroll_tokens` ADD `max_uses` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `enroll_tokens` ADD `uses` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `enroll_tokens` ADD `revoked_at` integer;--> statement-breakpoint
INSERT INTO `groups` (`id`, `name`, `created_at`) VALUES ('default', '기본', CAST(unixepoch('subsec') * 1000 AS INTEGER));
--> statement-breakpoint
-- 기존 토큰은 이미 쓰였으면 사용 횟수 1 로 본다
UPDATE `enroll_tokens` SET `uses` = 1 WHERE `used_at` IS NOT NULL;
