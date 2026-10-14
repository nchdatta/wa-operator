CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`party` text,
	`item` text,
	`qty` real,
	`note` text,
	`source` text DEFAULT 'text' NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ledger_day` ON `ledger` (`day`);--> statement-breakpoint
CREATE INDEX `ledger_party` ON `ledger` (`party`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`name` text PRIMARY KEY NOT NULL,
	`prompt` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`repeat` text NOT NULL,
	`time` text NOT NULL,
	`on` text,
	`next_at` integer,
	`last_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `schedules_due` ON `schedules` (`enabled`,`next_at`);--> statement-breakpoint
ALTER TABLE `operator_runs` ADD `origin` text DEFAULT 'owner' NOT NULL;