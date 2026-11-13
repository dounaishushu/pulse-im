ALTER TABLE pulse.media ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE pulse.media ADD COLUMN admin_owner_id uuid REFERENCES pulse.admin_accounts(id);
ALTER TABLE pulse.media ADD CONSTRAINT media_one_owner CHECK((owner_id IS NOT NULL)<>(admin_owner_id IS NOT NULL));
CREATE UNIQUE INDEX media_admin_request ON pulse.media(admin_owner_id,request_id) WHERE admin_owner_id IS NOT NULL;
ALTER TABLE pulse.conversations ADD COLUMN deleted_at timestamptz;
ALTER TABLE pulse.conversations ADD COLUMN display_count_offset integer NOT NULL DEFAULT 0;
