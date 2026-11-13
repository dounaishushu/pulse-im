-- Existing PHP profiles can exceed new-edit limits; preserve them during import.
ALTER TABLE pulse.users ALTER COLUMN nickname TYPE varchar(64);
ALTER TABLE pulse.users ALTER COLUMN phone TYPE varchar(32);
