CREATE TABLE `remote_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`generated_at` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remote_usage_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` text NOT NULL,
	`window_id` text NOT NULL,
	`used_percent` real,
	`captured_at` text NOT NULL,
	`capture_bucket` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `remote_usage_history_time_idx` ON `remote_usage_history` (`captured_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_usage_history_bucket_idx` ON `remote_usage_history` (`provider_id`,`window_id`,`capture_bucket`);