-- Ledgerly schema for PostgreSQL (dates as ISO text kept for parity with the SQLite build;
-- switch to TIMESTAMPTZ/DATE columns when moving the driver to drizzle-orm/node-postgres).
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX refresh_family_idx ON refresh_tokens (family_id);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  tax_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX customers_org_idx ON customers (org_id, name);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'partially_paid', 'paid', 'void')),
  currency TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal_cents BIGINT NOT NULL,
  tax_cents BIGINT NOT NULL,
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  amount_paid_cents BIGINT NOT NULL CHECK (amount_paid_cents >= 0),
  notes TEXT,
  sent_at TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (amount_paid_cents <= total_cents)
);
CREATE UNIQUE INDEX invoices_org_number_uq ON invoices (org_id, number);
CREATE INDEX invoices_org_status_idx ON invoices (org_id, status);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(14,4) NOT NULL,
  unit_price_cents BIGINT NOT NULL,
  tax_rate_bp BIGINT NOT NULL,
  subtotal_cents BIGINT NOT NULL,
  tax_cents BIGINT NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX payments_org_idx ON payments (org_id, paid_at);

CREATE TABLE idempotency_keys (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code BIGINT NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  vendor TEXT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  spent_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX expenses_org_idx ON expenses (org_id, spent_at);

ALTER TABLE organizations ADD COLUMN invoice_seq BIGINT NOT NULL DEFAULT 0;
