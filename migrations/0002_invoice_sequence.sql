-- Per-organization invoice counter so deleted drafts never cause a number to be reused.
ALTER TABLE organizations ADD COLUMN invoice_seq INTEGER NOT NULL DEFAULT 0;
UPDATE organizations SET invoice_seq = (
  SELECT COALESCE(MAX(CAST(SUBSTR(number, 5) AS INTEGER)), 0) FROM invoices WHERE invoices.org_id = organizations.id
);
