-- Enable Banking (European banks through PSD2), and the currency of accounts that aren't in the
-- budget's currency. Hand-written like 0019/0020: db:generate would also propose the pending
-- legacy cleanup (see CLAUDE.md).
ALTER TABLE `accounts` ADD `currency` text;
--> statement-breakpoint
CREATE TABLE `enable_banking_config` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`private_key` text NOT NULL,
	`redirect_url` text NOT NULL,
	`environment` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `enable_banking_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`aspsp_name` text NOT NULL,
	`aspsp_country` text NOT NULL,
	`valid_until` text NOT NULL,
	`sync_status` text DEFAULT 'good' NOT NULL,
	`sync_error` text,
	`last_synced_at` text,
	`last_attempt_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `enable_banking_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`account_uid` text NOT NULL,
	`identification_hash` text NOT NULL,
	`account_id` text,
	`name` text NOT NULL,
	`iban_mask` text,
	`iban_hash` text,
	`currency` text,
	`cash_account_type` text,
	`is_enabled` integer DEFAULT 1 NOT NULL,
	`in_consent` integer DEFAULT 1 NOT NULL,
	`sync_from` text,
	`last_synced_at` text,
	`opening_balance_pending` integer DEFAULT 0 NOT NULL,
	`bank_balance` integer,
	`bank_balance_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `enable_banking_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enable_banking_account_unique` ON `enable_banking_accounts` (`connection_id`,`identification_hash`);
