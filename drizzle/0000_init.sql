CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`outcome` text NOT NULL,
	`metadata_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `deferred_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE TABLE `inbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`kind` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `operator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`prompt` text NOT NULL,
	`source_message_id` text,
	`session_id` text,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`tainted` integer DEFAULT false NOT NULL,
	`result_preview` text,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `runs_status` ON `operator_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `operator_sessions` (
	`day` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE TABLE `operator_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`disabled_reason` text,
	`pin_hash` text,
	`unlocked_until` integer,
	`last_activity_at` integer,
	`failed_pins` integer DEFAULT 0 NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`last_owner_message_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pin_requests` (
	`token` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`approval_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `proposed_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`run_id` text,
	`tool_use_id` text,
	`tool_name` text NOT NULL,
	`preview` text NOT NULL,
	`input_hash` text NOT NULL,
	`tier` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`needs_pin` integer DEFAULT false NOT NULL,
	`card_message_id` text,
	`edit_note` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `actions_status` ON `proposed_actions` (`status`);--> statement-breakpoint
CREATE TABLE `tool_tiers` (
	`tool_name` text PRIMARY KEY NOT NULL,
	`tier` text,
	`suggested` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
