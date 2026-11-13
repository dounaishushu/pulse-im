-- Personal clear/delete must not let a later read watermark invent receipts
-- for imported messages which were previously invisible to this member.
ALTER TABLE pulse.receipt_exclusions DROP CONSTRAINT receipt_exclusions_kind_check;
ALTER TABLE pulse.receipt_exclusions ADD CONSTRAINT receipt_exclusions_kind_check
 CHECK (kind IN ('read','delivered','legacy_read','legacy_delivered'));
