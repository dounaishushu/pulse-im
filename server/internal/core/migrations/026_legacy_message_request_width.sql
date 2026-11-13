-- Old PHP messages allow 80-character request IDs. Preserve them byte for byte;
-- the new API continues issuing at most 64 characters for new requests.
ALTER TABLE pulse.messages ALTER COLUMN request_id TYPE varchar(80);
