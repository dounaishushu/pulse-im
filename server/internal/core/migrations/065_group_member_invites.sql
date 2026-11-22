-- Existing groups keep manager-only invitations until a manager opts in.
ALTER TABLE pulse.conversations ADD COLUMN allow_member_invites boolean NOT NULL DEFAULT false;
