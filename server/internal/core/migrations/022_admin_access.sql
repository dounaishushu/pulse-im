CREATE TABLE pulse.admin_access_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id),enabled boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1);
INSERT INTO pulse.admin_access_settings(id) VALUES(true);
CREATE TABLE pulse.admin_access_rules (network cidr PRIMARY KEY,expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pulse.admin_ops_nonces (nonce varchar(64) PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX admin_ops_nonces_created ON pulse.admin_ops_nonces(created_at);
