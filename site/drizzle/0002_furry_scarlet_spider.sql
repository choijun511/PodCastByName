CREATE TABLE `discovery_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`fetched_at` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracking_jobs` (
	`person_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracking_people` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` text NOT NULL,
	`next_run_at` integer NOT NULL
);
