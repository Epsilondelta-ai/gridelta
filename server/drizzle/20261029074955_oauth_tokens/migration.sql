CREATE TABLE `oauth_tokens` (
	`provider` text PRIMARY KEY,
	`credential` text NOT NULL,
	`key_version` integer NOT NULL,
	`account` text DEFAULT '' NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
