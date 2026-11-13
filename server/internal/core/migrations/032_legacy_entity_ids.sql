-- Preserve old terminal friend-request status and numeric cross-references.
ALTER TABLE pulse.friend_requests DROP CONSTRAINT friend_requests_status_check;
ALTER TABLE pulse.friend_requests ADD CONSTRAINT friend_requests_status_check
 CHECK (status IN ('pending','accepted','rejected','blocked'));
ALTER TABLE pulse.legacy_ids DROP CONSTRAINT legacy_ids_entity_check;
ALTER TABLE pulse.legacy_ids ADD CONSTRAINT legacy_ids_entity_check
 CHECK (entity IN ('user','conversation','message','media','task','question','record','admin','folder',
 'friend_request','notification','dispatch','dispatch_run','device'));
