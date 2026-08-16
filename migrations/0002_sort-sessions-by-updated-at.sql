ALTER TABLE `cli_sessions` ADD `updated_at` text;
UPDATE `cli_sessions` SET `updated_at` = `created_at`;
