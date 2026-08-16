CREATE TABLE `checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`repo_root` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkouts_device_repo_worktree_unique` ON `checkouts` (`device_id`,`repo_root`,`worktree_path`);--> statement-breakpoint
CREATE INDEX `checkouts_device_repo_idx` ON `checkouts` (`device_id`,`repo_root`);--> statement-breakpoint
CREATE TABLE `cli_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`cli` text NOT NULL,
	`external_session_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cli_sessions_cli_check" CHECK("cli_sessions"."cli" IN ('codex','claude'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_sessions_device_cli_external_unique` ON `cli_sessions` (`device_id`,`cli`,`external_session_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`task_id` text NOT NULL,
	`cli_session_id` text NOT NULL,
	`session_run_id` text,
	`checkout_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cli_session_id`) REFERENCES `cli_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_run_id`) REFERENCES `session_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkout_id`) REFERENCES `checkouts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "executions_status_check" CHECK("executions"."status" IN ('active','finished','abandoned'))
);
--> statement-breakpoint
CREATE INDEX `executions_device_status_idx` ON `executions` (`device_id`,`status`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`state` text NOT NULL,
	`parent_pr_id` text,
	`created_by_device_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`parent_pr_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pull_requests_state_check" CHECK("pull_requests"."state" IN ('open','closed','merged'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repo_number_unique` ON `pull_requests` (`repo`,`number`);--> statement-breakpoint
CREATE TABLE `session_run_checkouts` (
	`device_id` text NOT NULL,
	`session_run_id` text NOT NULL,
	`checkout_id` text NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`device_id`, `session_run_id`, `checkout_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_run_id`) REFERENCES `session_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkout_id`) REFERENCES `checkouts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_run_pull_requests` (
	`device_id` text NOT NULL,
	`session_run_id` text NOT NULL,
	`checkout_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`device_id`, `session_run_id`, `checkout_id`, `pull_request_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_run_id`) REFERENCES `session_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkout_id`) REFERENCES `checkouts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`cli_session_id` text NOT NULL,
	`terminal_id` text,
	`started_cwd` text,
	`source` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`ended_at` text,
	`end_reason` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cli_session_id`) REFERENCES `cli_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_runs_device_active_idx` ON `session_runs` (`device_id`,`ended_at`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `task_pull_requests` (
	`task_id` text NOT NULL,
	`pull_request_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`task_id`, `pull_request_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by_device_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" IN ('open','active','done','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_issue_id_unique` ON `tasks` (`issue_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`access_subject` text NOT NULL,
	`email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_access_subject_unique` ON `users` (`access_subject`);--> statement-breakpoint
CREATE TABLE `workpad_links` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`task_id` text,
	`checkout_id` text NOT NULL,
	`ref` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`checkout_id`) REFERENCES `checkouts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workpad_links_device_task_checkout_ref_unique` ON `workpad_links` (`device_id`,`task_id`,`checkout_id`,`ref`);