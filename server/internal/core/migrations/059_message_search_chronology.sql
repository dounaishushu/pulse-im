CREATE INDEX messages_search_chronology ON pulse.messages(created_at DESC,id DESC) WHERE NOT revoked;
