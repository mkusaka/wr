CREATE INDEX `conversation_links_created_idx` ON `conversation_links` (`created_at`);--> statement-breakpoint
CREATE INDEX `pull_requests_current_updated_idx` ON `pull_requests` ("state" = 'open',`updated_at`);--> statement-breakpoint
CREATE INDEX `session_runs_current_last_seen_idx` ON `session_runs` ("ended_at" IS NULL,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `tasks_current_updated_idx` ON `tasks` ("status" = 'open' OR "status" = 'active',`updated_at`);