CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX messages_body_search ON pulse.messages USING gin(body gin_trgm_ops) WHERE NOT revoked;
CREATE INDEX messages_global_time ON pulse.messages(created_at DESC,id) WHERE NOT revoked;
