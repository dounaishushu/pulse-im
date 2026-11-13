-- Settings exposed by the PHP account page but absent from the first Go model.
ALTER TABLE pulse.privacy_settings
 ADD COLUMN phone_search text NOT NULL DEFAULT 'everyone' CHECK (phone_search IN ('everyone','contacts')),
 ADD COLUMN voice_call text NOT NULL DEFAULT 'everyone' CHECK (voice_call IN ('everyone','contacts','nobody')),
 ADD COLUMN voice_call_peer_to_peer text NOT NULL DEFAULT 'everyone' CHECK (voice_call_peer_to_peer IN ('everyone','contacts','nobody')),
 ADD COLUMN show_active_sessions boolean NOT NULL DEFAULT true;
ALTER TABLE pulse.privacy_exceptions DROP CONSTRAINT privacy_exceptions_scope_check;
ALTER TABLE pulse.privacy_exceptions ADD CONSTRAINT privacy_exceptions_scope_check
 CHECK (scope IN ('temporary_chat','group_invites','phone','last_seen','phone_search','voice_call'));
