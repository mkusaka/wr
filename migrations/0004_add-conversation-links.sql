CREATE TABLE `conversation_links` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`cli_session_id` text NOT NULL,
	`checkout_id` text,
	`provider` text NOT NULL,
	`external_key` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cli_session_id`) REFERENCES `cli_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkout_id`) REFERENCES `checkouts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversation_links_provider_check" CHECK("provider" IN ('slack'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_links_device_session_provider_external_unique` ON `conversation_links` (`device_id`,`cli_session_id`,`provider`,`external_key`);