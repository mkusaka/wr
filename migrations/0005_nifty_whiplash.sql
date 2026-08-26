PRAGMA defer_foreign_keys=ON;
DROP TABLE IF EXISTS `__new_cli_sessions`;
DROP TABLE IF EXISTS `__backup_session_runs`;
DROP TABLE IF EXISTS `__backup_executions`;
DROP TABLE IF EXISTS `__backup_session_run_checkouts`;
DROP TABLE IF EXISTS `__backup_session_run_pull_requests`;
DROP TABLE IF EXISTS `__backup_conversation_links`;
CREATE TABLE `__new_cli_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`cli` text NOT NULL,
	`external_session_id` text NOT NULL,
	`initial_prompt` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cli_sessions_cli_check" CHECK("cli" IN ('codex','claude','devin','pi'))
);
INSERT INTO `__new_cli_sessions`("id", "device_id", "cli", "external_session_id", "initial_prompt", "created_at", "updated_at") SELECT "id", "device_id", "cli", "external_session_id", "initial_prompt", "created_at", "updated_at" FROM `cli_sessions`;

CREATE TABLE `__backup_session_runs` AS SELECT * FROM `session_runs`;
CREATE TABLE `__backup_executions` AS SELECT * FROM `executions`;
CREATE TABLE `__backup_session_run_checkouts` AS SELECT * FROM `session_run_checkouts`;
CREATE TABLE `__backup_session_run_pull_requests` AS SELECT * FROM `session_run_pull_requests`;
CREATE TABLE `__backup_conversation_links` AS SELECT * FROM `conversation_links`;
DELETE FROM `conversation_links`;
DELETE FROM `session_run_pull_requests`;
DELETE FROM `session_run_checkouts`;
DELETE FROM `executions`;
DELETE FROM `session_runs`;
DROP TABLE `cli_sessions`;
ALTER TABLE `__new_cli_sessions` RENAME TO `cli_sessions`;
CREATE UNIQUE INDEX `cli_sessions_device_cli_external_unique` ON `cli_sessions` (`device_id`,`cli`,`external_session_id`);
INSERT INTO `session_runs`("id", "device_id", "cli_session_id", "terminal_id", "started_cwd", "source", "started_at", "last_seen_at", "ended_at", "end_reason") SELECT "id", "device_id", "cli_session_id", "terminal_id", "started_cwd", "source", "started_at", "last_seen_at", "ended_at", "end_reason" FROM `__backup_session_runs`;
INSERT INTO `executions`("id", "device_id", "task_id", "cli_session_id", "session_run_id", "checkout_id", "status", "started_at", "finished_at") SELECT "id", "device_id", "task_id", "cli_session_id", "session_run_id", "checkout_id", "status", "started_at", "finished_at" FROM `__backup_executions`;
INSERT INTO `session_run_checkouts`("device_id", "session_run_id", "checkout_id", "last_seen_at") SELECT "device_id", "session_run_id", "checkout_id", "last_seen_at" FROM `__backup_session_run_checkouts`;
INSERT INTO `session_run_pull_requests`("device_id", "session_run_id", "checkout_id", "pull_request_id", "created_at") SELECT "device_id", "session_run_id", "checkout_id", "pull_request_id", "created_at" FROM `__backup_session_run_pull_requests`;
INSERT INTO `conversation_links`("id", "device_id", "cli_session_id", "checkout_id", "provider", "external_key", "url", "created_at") SELECT "id", "device_id", "cli_session_id", "checkout_id", "provider", "external_key", "url", "created_at" FROM `__backup_conversation_links`;
DROP TABLE `__backup_session_runs`;
DROP TABLE `__backup_executions`;
DROP TABLE `__backup_session_run_checkouts`;
DROP TABLE `__backup_session_run_pull_requests`;
DROP TABLE `__backup_conversation_links`;
PRAGMA defer_foreign_keys=OFF;