CREATE TABLE `active_knowledge_sources` (
	`source_id` integer PRIMARY KEY NOT NULL,
	`activated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sync_leases` (
	`key` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA optimize;
