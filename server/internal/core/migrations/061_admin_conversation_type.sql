-- Keep the legacy administrative customer-service classification while using
-- the ordinary group membership and delivery rules in the messaging core.
ALTER TABLE pulse.conversations
 ADD COLUMN management_type text NOT NULL DEFAULT ''
 CHECK (management_type IN ('','customer_service'));
ALTER TABLE pulse.conversations ADD CONSTRAINT conversations_management_type_kind
 CHECK (management_type='' OR kind='group');
