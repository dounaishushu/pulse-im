-- 已有库建议使用 php tools/optimize-admin-user-indexes.php，自动检查后再添加，重复运行安全。
ALTER TABLE `login_logs` ADD INDEX `idx_admin_login_user_success_id` (`user_id`, `success`, `id`);
ALTER TABLE `auth_tokens` ADD INDEX `idx_admin_token_user_expiry_activity` (`user_id`, `expires_at`, `last_used_at`);
