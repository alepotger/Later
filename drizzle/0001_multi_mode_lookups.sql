ALTER TABLE `accounts` ADD `telegram_chat_id` text;--> statement-breakpoint
CREATE INDEX `accounts_ingest_token_hash_idx` ON `accounts` (`ingest_token_hash`);--> statement-breakpoint
CREATE INDEX `accounts_telegram_chat_idx` ON `accounts` (`telegram_chat_id`);