-- ============================================================================
-- 0012 — invoices (brief §29, automated invoices)
--
-- An invoice is drafted from what is already on record: a client's priced
-- projects for a month (§32), each project billed at most once. Drafts are
-- editable and unnumbered; issuing one gives it the next number of the year
-- and freezes it, so the numbering has no gaps and an issued invoice never
-- changes (a mistake is voided and reissued). Nothing is sent anywhere: the
-- invoice prints to PDF from the browser, offline (§46).
-- ============================================================================

CREATE TYPE invoice_status AS ENUM ('draft','issued','paid','void');

CREATE TABLE billing_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- one row
  company_name       text NOT NULL DEFAULT 'Aktivacity',
  company_address    text,
  tax_registration   text,                                        -- TRN
  default_vat_rate   numeric(5,2) NOT NULL DEFAULT 5.00 CHECK (default_vat_rate >= 0 AND default_vat_rate <= 100),
  payment_terms_days int NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  payment_details    text,                                        -- bank, IBAN
  footer_note        text,
  updated_by         bigint REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_settings (id) VALUES (1);

CREATE TABLE invoice_number_sequence (
  period_year int PRIMARY KEY,
  last_number int NOT NULL DEFAULT 0
);

CREATE TABLE invoices (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_no      text UNIQUE,                                  -- INV-2026-0001, set on issue
  client_id       bigint NOT NULL REFERENCES clients(id),
  client_month_id bigint REFERENCES client_months(id),
  status          invoice_status NOT NULL DEFAULT 'draft',
  currency        char(3) NOT NULL DEFAULT 'AED',
  vat_rate        numeric(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  subtotal        numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount      numeric(14,2) NOT NULL DEFAULT 0,
  total           numeric(14,2) NOT NULL DEFAULT 0,
  issue_date      date,
  due_date        date,
  notes           text,
  created_by      bigint NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  issued_by       bigint REFERENCES users(id),
  issued_at       timestamptz,
  paid_at         date,
  voided_at       timestamptz,
  void_reason     text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'draft') = (invoice_no IS NULL)),
  CHECK (status = 'draft' OR (issue_date IS NOT NULL AND due_date IS NOT NULL)),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX invoices_client_idx ON invoices (client_id, created_at DESC);
CREATE INDEX invoices_status_idx ON invoices (status);
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_lines (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id  bigint NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  project_id  bigint REFERENCES projects(id),
  position    int NOT NULL,
  description text NOT NULL,
  quantity    numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price  numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  amount      numeric(14,2) NOT NULL,
  UNIQUE (invoice_id, position)
);
CREATE INDEX invoice_lines_project_idx ON invoice_lines (project_id) WHERE project_id IS NOT NULL;
