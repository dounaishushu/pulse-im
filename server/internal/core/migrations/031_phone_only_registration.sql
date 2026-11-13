-- PHP permits registration with a phone number before a username is chosen.
-- The internal unique account key is never exposed by public DTOs or search.
ALTER TABLE pulse.users ADD COLUMN account_is_internal boolean NOT NULL DEFAULT false;
