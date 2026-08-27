CREATE INDEX `devices_user_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `executions_task_idx` ON `executions` (`task_id`,`device_id`,`checkout_id`);--> statement-breakpoint
CREATE INDEX `executions_cli_session_idx` ON `executions` (`cli_session_id`,`task_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `session_run_checkouts_session_run_idx` ON `session_run_checkouts` (`session_run_id`,`checkout_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `session_run_pull_requests_pull_request_idx` ON `session_run_pull_requests` (`pull_request_id`,`checkout_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `workpad_links_task_idx` ON `workpad_links` (`task_id`,`device_id`,`checkout_id`);