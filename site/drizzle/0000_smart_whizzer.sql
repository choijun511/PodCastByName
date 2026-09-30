CREATE TABLE `demand` (
	`person_id` text PRIMARY KEY NOT NULL,
	`requested_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`data` text NOT NULL,
	`evidence` text NOT NULL,
	`seq` integer NOT NULL,
	`approved_at` text NOT NULL,
	`status` text DEFAULT 'approved' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_seq_unique` ON `episodes` (`seq`);--> statement-breakpoint
CREATE TABLE `hidden` (
	`episode_id` text PRIMARY KEY NOT NULL,
	`hidden_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_hash` text NOT NULL,
	`query` text NOT NULL,
	`identity_hint` text NOT NULL,
	`query_key` text NOT NULL,
	`hint_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`person_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_device_query_hint` ON `requests` (`client_hash`,`query_key`,`hint_key`);--> statement-breakpoint
CREATE INDEX `requests_device_created` ON `requests` (`client_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `votes` (
	`episode_id` text NOT NULL,
	`client_hash` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`episode_id`, `client_hash`)
);
--> statement-breakpoint
CREATE INDEX `votes_client_created` ON `votes` (`client_hash`,`created_at`);