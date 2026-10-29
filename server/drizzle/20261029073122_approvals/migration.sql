CREATE TABLE `approvals` (
	`id` text PRIMARY KEY,
	`endpoint_id` text NOT NULL,
	`command` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer
);
