-- Carry original relative media references until every file is mapped and
-- verified in the private Go media store.
ALTER TABLE pulse.users ADD COLUMN legacy_avatar_url text;
ALTER TABLE pulse.conversations ADD COLUMN legacy_avatar_url text;
