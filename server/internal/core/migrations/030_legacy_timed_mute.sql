-- Imported PHP member mutes retain their remaining time. New mute controls
-- continue to use the permanent `muted` switch.
ALTER TABLE pulse.members ADD COLUMN muted_until timestamptz;
