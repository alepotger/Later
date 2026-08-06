CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`google_user_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`refresh_token_cipher` text,
	`access_token_cipher` text,
	`access_token_expires_at` integer,
	`playlist_id` text,
	`playlist_name` text,
	`ingest_token_hash` text,
	`last_token_refresh_at` integer,
	`reauth_notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_google_user_id_uq` ON `accounts` (`google_user_id`);--> statement-breakpoint
CREATE INDEX `accounts_status_idx` ON `accounts` (`status`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`share_key` text NOT NULL,
	`source` text NOT NULL,
	`raw_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_video_id` text,
	`resolved_tier` integer,
	`confidence` real,
	`failure_reason` text,
	`request_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_account_idempotency_uq` ON `items` (`account_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `items_account_status_idx` ON `items` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `items_share_key_idx` ON `items` (`share_key`);--> statement-breakpoint
CREATE INDEX `items_created_at_idx` ON `items` (`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`item_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`locked_until` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_item_kind_uq` ON `jobs` (`item_id`,`kind`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_to` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expires_idx` ON `oauth_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `playlist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`video_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`playlist_item_id` text,
	`item_id` text,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_entries_account_video_uq` ON `playlist_entries` (`account_id`,`video_id`);--> statement-breakpoint
CREATE TABLE `quota_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`quota_date` text NOT NULL,
	`units_spent` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quota_ledger_account_date_uq` ON `quota_ledger` (`account_id`,`quota_date`);--> statement-breakpoint
CREATE INDEX `quota_ledger_date_idx` ON `quota_ledger` (`quota_date`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_bucket_window_uq` ON `rate_limits` (`bucket`,`window_start`);--> statement-breakpoint
CREATE TABLE `video_cache` (
	`video_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`channel_title` text,
	`channel_id` text,
	`duration_seconds` integer,
	`availability` text NOT NULL,
	`fetched_at` integer NOT NULL
);
