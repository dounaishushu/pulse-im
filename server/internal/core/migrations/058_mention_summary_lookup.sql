CREATE INDEX messages_mention_summary ON pulse.messages(conversation_id,seq DESC)
    WHERE NOT revoked AND (content ? 'mentions' OR content->>'mention_all'='true');
