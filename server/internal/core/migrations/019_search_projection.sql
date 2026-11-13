ALTER TABLE pulse.messages ADD COLUMN search_text text GENERATED ALWAYS AS (
 body||' '||CASE WHEN kind='contact' THEN COALESCE(content#>>'{contact,nickname}','')||' '||COALESCE(content#>>'{contact,account}','')
 WHEN kind IN('image','video','audio','file') THEN COALESCE(content#>>'{media,filename}','') ELSE '' END
) STORED;
CREATE INDEX messages_search_projection ON pulse.messages USING gin(search_text gin_trgm_ops) WHERE NOT revoked;
DROP INDEX pulse.messages_body_search;
