CREATE TABLE `evidence_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`speaker_source` text,
	`speaker_attribution` text,
	`speaker_label` text,
	`start_time` text,
	`end_time` text,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_chunks_source_chunk_unique` ON `evidence_chunks` (`source_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `evidence_chunks_source_start_time_idx` ON `evidence_chunks` (`source_id`,`start_time`);--> statement-breakpoint
CREATE TABLE `judge_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`normalized_claim` text NOT NULL,
	`action` text NOT NULL,
	`correction` text,
	`confidence_permille` integer NOT NULL,
	`evidence_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `meeting_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `judge_receipts_session_time_idx` ON `judge_receipts` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `judge_receipts_claim_time_idx` ON `judge_receipts` (`normalized_claim`,`created_at`);--> statement-breakpoint
CREATE TABLE `knowledge_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`source_date` text NOT NULL,
	`web_url` text NOT NULL,
	`remote_created_at` text NOT NULL,
	`remote_updated_at` text NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`synced_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_sources_provider_external_id_unique` ON `knowledge_sources` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `knowledge_sources_provider_date_idx` ON `knowledge_sources` (`provider`,`source_date`);--> statement-breakpoint
CREATE INDEX `knowledge_sources_remote_updated_at_idx` ON `knowledge_sources` (`remote_updated_at`);--> statement-breakpoint
CREATE TABLE `meeting_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE TABLE `utterances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `meeting_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `utterances_session_time_idx` ON `utterances` (`session_id`,`captured_at`);
--> statement-breakpoint
PRAGMA optimize;
