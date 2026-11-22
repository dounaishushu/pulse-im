-- IPPure's public endpoint describes its caller. Keep client-reported locations
-- separate from the server-side IP cache, scoped to the reporting user and IP.
CREATE TABLE pulse.client_reported_ip_locations (
    user_id uuid NOT NULL REFERENCES pulse.users(id) ON DELETE CASCADE,
    ip inet NOT NULL,
    country varchar(128) NOT NULL DEFAULT '',
    province varchar(128) NOT NULL DEFAULT '',
    city varchar(128) NOT NULL DEFAULT '',
    district varchar(128) NOT NULL DEFAULT '',
    checked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, ip)
);
CREATE INDEX client_reported_ip_locations_expiry
    ON pulse.client_reported_ip_locations (checked_at, user_id, ip);
