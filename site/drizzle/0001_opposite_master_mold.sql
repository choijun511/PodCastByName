CREATE TABLE `intake_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`person_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`fingerprint` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intake_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intake_leases` (
	`key` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intake_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intake_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`run_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intake_snapshot_candidate` ON `intake_snapshots` (`candidate_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `intake_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_status` text NOT NULL,
	`last_run_at` text NOT NULL,
	`next_run_at` integer NOT NULL
);
