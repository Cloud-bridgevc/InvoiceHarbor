-- InvoiceHarbor PostgreSQL schema (financial system of record).
-- Marketing / CRM data lives in a separate database (see docs/HUBSPOT.md) and is never joined here.
-- Every table is tenant-scoped; Row-Level Security enforces isolation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS ar;
SET search_path = ar;

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  external_ref  text,                         -- ERP customer number
  name          text NOT NULL,
  segment       text,
  terms_days    int  NOT NULL CHECK (terms_days BETWEEN 0 AND 365),
  credit_limit  numeric(14,2),
  key_account   boolean NOT NULL DEFAULT false,
  ap_contact_name  text,
  ap_contact_email text,
  UNIQUE (tenant_id, external_ref)
);

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  s3_bucket     text NOT NULL,
  s3_key        text NOT NULL,
  sha256        text NOT NULL,
  content_type  text NOT NULL,
  uploaded_by   text NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  number        text NOT NULL,
  po_number     text,
  issue_date    date NOT NULL,
  due_date      date NOT NULL CHECK (due_date >= issue_date),
  payment_terms text NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'USD',
  subtotal      numeric(14,2) NOT NULL,
  tax           numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL CHECK (total >= 0),   -- authoritative recorded amount
  source        text NOT NULL CHECK (source IN ('erp_import','textract_extraction','manual')),
  document_id   uuid REFERENCES documents(id),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE invoice_line_items (
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no       int  NOT NULL,
  description   text NOT NULL,
  quantity      numeric(14,4) NOT NULL,
  unit_price    numeric(14,4) NOT NULL,
  amount        numeric(14,2) NOT NULL,
  taxable       boolean NOT NULL DEFAULT true,
  PRIMARY KEY (invoice_id, line_no)
);

CREATE TABLE invoice_review_flags (
  id            bigserial PRIMARY KEY,
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  code          text NOT NULL,
  message       text NOT NULL,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by   text,
  resolved_at   timestamptz
);

-- Payments: only status='verified' reduces a balance.
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  received_date date NOT NULL,
  method        text NOT NULL,
  reference     text,
  source        text NOT NULL CHECK (source IN ('bank_feed','lockbox','remittance_advice','manual')),
  status        text NOT NULL CHECK (status IN ('unconfirmed','verified','dismissed')),
  bank_reference text,
  verified_by   text,
  verified_at   timestamptz,
  CONSTRAINT verified_requires_evidence CHECK (
    status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND (source IN ('bank_feed','lockbox') OR bank_reference IS NOT NULL))
  )
);

CREATE TABLE payment_applications (
  payment_id    uuid NOT NULL REFERENCES payments(id),
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  applied_by    text NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_id, invoice_id)
);

-- Derived balance: there is deliberately no writable "paid" column on invoices.
CREATE VIEW invoice_balances AS
SELECT i.id AS invoice_id, i.tenant_id, i.total,
       COALESCE(SUM(pa.amount) FILTER (WHERE p.status = 'verified'), 0)              AS verified_paid,
       i.total - COALESCE(SUM(pa.amount) FILTER (WHERE p.status = 'verified'), 0)   AS balance,
       COALESCE(SUM(pa.amount) FILTER (WHERE p.status = 'unconfirmed'), 0)          AS unconfirmed_claimed
FROM invoices i
LEFT JOIN payment_applications pa ON pa.invoice_id = i.id
LEFT JOIN payments p ON p.id = pa.payment_id
GROUP BY i.id;

CREATE TABLE disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  invoice_id      uuid NOT NULL REFERENCES invoices(id),
  category        text NOT NULL CHECK (category IN ('quantity_shortfall','pricing','damaged_goods','duplicate_billing','other')),
  disputed_amount numeric(14,2) NOT NULL CHECK (disputed_amount >= 0),
  status          text NOT NULL CHECK (status IN ('open','resolved','withdrawn')),
  owner           text,
  opened_date     date NOT NULL,
  resolved_date   date,
  resolution      text
);
CREATE TABLE dispute_documents (dispute_id uuid REFERENCES disputes(id), doc_type text NOT NULL, document_id uuid REFERENCES documents(id), PRIMARY KEY (dispute_id, doc_type));
CREATE TABLE dispute_messages (
  id            bigserial PRIMARY KEY,
  dispute_id    uuid NOT NULL REFERENCES disputes(id),
  direction     text NOT NULL CHECK (direction IN ('customer','internal')),
  author        text NOT NULL,
  sent_at       timestamptz NOT NULL,
  subject       text,
  body          text NOT NULL
);
CREATE TABLE dispute_analyses (
  id            bigserial PRIMARY KEY,
  dispute_id    uuid NOT NULL REFERENCES disputes(id),
  generator     text NOT NULL,              -- 'rules' | 'bedrock:<model-id>'
  output        jsonb NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE info_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES invoices(id),
  item text NOT NULL, detail text, status text NOT NULL CHECK (status IN ('open','fulfilled','cancelled')), requested_date date NOT NULL
);
CREATE TABLE promises_to_pay (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid NOT NULL REFERENCES invoices(id),
  promised_date date NOT NULL, amount numeric(14,2) NOT NULL, status text NOT NULL CHECK (status IN ('open','kept','broken')),
  recorded_by text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Reminder drafts: cannot reach 'sent_externally' without a named approval.
CREATE TABLE reminder_drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  tone          text NOT NULL,
  sensitive     boolean NOT NULL,
  subject       text NOT NULL,
  body          text NOT NULL,
  allowed_facts jsonb NOT NULL,
  validation    jsonb NOT NULL,
  generator     text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending_approval','approved','rejected','sent_externally')),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_by   text,
  approved_at   timestamptz,
  sent_recorded_by text,
  sent_at       timestamptz,
  CONSTRAINT approval_required CHECK (status NOT IN ('approved','sent_externally') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT validation_passed CHECK (status NOT IN ('approved','sent_externally') OR (validation->>'ok')::boolean)
);

CREATE TABLE classification_snapshots (
  invoice_id    uuid NOT NULL REFERENCES invoices(id),
  as_of         date NOT NULL,
  class         text NOT NULL CHECK (class IN ('current','overdue','disputed','awaiting_information','requires_review','paid')),
  flags         text[] NOT NULL,
  days_overdue  int NOT NULL,
  balance       numeric(14,2) NOT NULL,
  priority      numeric(6,2),
  factors       jsonb,
  PRIMARY KEY (invoice_id, as_of)
);

CREATE TABLE business_rules (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants(id),
  weights       jsonb NOT NULL,
  reminder_cooldown_days int NOT NULL DEFAULT 7,
  escalation_days int NOT NULL DEFAULT 45,
  request_undisputed_portion boolean NOT NULL DEFAULT true,
  auto_send_reminders boolean NOT NULL DEFAULT false CHECK (auto_send_reminders = false),
  auto_mark_paid      boolean NOT NULL DEFAULT false CHECK (auto_mark_paid = false)
);

-- Append-only audit log.
CREATE TABLE activity_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  type          text NOT NULL,
  invoice_id    uuid REFERENCES invoices(id),
  message       text NOT NULL,
  metadata      jsonb
);
CREATE RULE activity_log_no_update AS ON UPDATE TO activity_log DO INSTEAD NOTHING;
CREATE RULE activity_log_no_delete AS ON DELETE TO activity_log DO INSTEAD NOTHING;

CREATE INDEX ON invoices (tenant_id, due_date);
CREATE INDEX ON payments (tenant_id, status);
CREATE INDEX ON disputes (tenant_id, status);
CREATE INDEX ON activity_log (tenant_id, at DESC);

-- Row-level security (repeat for each tenant-scoped table).
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices USING (tenant_id = current_setting('app.tenant_id')::uuid);
