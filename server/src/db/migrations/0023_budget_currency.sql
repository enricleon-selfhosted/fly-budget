-- Budgeting across currencies (docs/multi-currency/decisions.md M2-M4). Hand-written like
-- 0019-0022 (db:generate would also propose the pending legacy cleanup).
CREATE TABLE `budget_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`currency` text,
	`download_rates` integer DEFAULT 0 NOT NULL,
	`rates_updated_at` text,
	`rates_error` text
);
--> statement-breakpoint
CREATE TABLE `exchange_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`rate` real NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `exchange_rates_pair_date_idx` ON `exchange_rates` (`base`,`quote`,`date`);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `fx_rate` real;
--> statement-breakpoint
ALTER TABLE `transactions` ADD `fx_source` text;
