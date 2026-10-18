# InvoiceHarbor architecture

## Overview

```
 ERP export / email / upload
          │
          ▼
   ┌──────────────┐   S3 event    ┌──────────────────┐   fields + confidence
   │  Amazon S3   │──────────────▶│ Amazon Textract  │──────────────┐
   │ (SSE-KMS,    │               │  AnalyzeExpense  │              ▼
   │  versioned)  │               └──────────────────┘     ┌────────────────────┐
   └──────────────┘                                        │ Extraction checks  │
                                                           │ (arithmetic, PO,   │
                                                           │ customer match)    │
                                                           └─────────┬──────────┘
                                                      human confirm  │
                                                                     ▼
 Bank feed / lockbox ──▶ payments (unconfirmed|verified) ──▶ ┌────────────────────┐
                                                             │    PostgreSQL      │
 Dispute email threads ─────────────────────────────────────▶│  (system of record)│
                                                             └───┬───────────┬────┘
                                                                 │           │
                              ┌──────────────────────────────────┘           │
                              ▼                                              ▼
                ┌──────────────────────────┐                   ┌──────────────────────────┐
                │ Rules engine             │                   │ Amazon Bedrock           │
                │ classification, aging,   │                   │ dispute summaries,       │
                │ priority, estimates      │                   │ reminder drafts          │
                └────────────┬─────────────┘                   └────────────┬─────────────┘
                             │                                              │ validated against
                             ▼                                              ▼ allowed facts
                    App API + dashboard ◀──── staff review & approval ◀── drafts (pending)
                             ▲
                AWS Lambda (EventBridge Scheduler): nightly aging snapshots, promise monitor,
                dispute SLA flags, weekly report. No send or payment permissions.
```

## Service responsibilities

| Concern | Service | Notes |
|---|---|---|
| Invoice documents | **Amazon S3** | Private bucket per environment, prefix per tenant, SSE-KMS, versioning plus Object Lock for the audit trail. |
| Extraction | **Amazon Textract AnalyzeExpense** | Maps `INVOICE_RECEIPT_ID`, `INVOICE_RECEIPT_DATE`, `DUE_DATE`, `PAYMENT_TERMS`, `RECEIVER_NAME`, `PO_NUMBER`, `SUBTOTAL`, `TAX`, `TOTAL` and line items (`server/aws/adapters.js`). Results are always held for human confirmation. |
| Language tasks | **Amazon Bedrock (Converse API)** | Dispute narrative and reminder drafting only. Figures, missing-document lists and classifications stay rule-derived. Model output is validated before it is stored. |
| Records & workflow | **PostgreSQL** (Amazon RDS / Aurora) | `db/schema.sql`. Balances come from a view, and there is no writable "paid" column. CHECK constraints enforce approval and validation on reminders and lock auto-send and auto-paid off. |
| Scheduled tasks | **AWS Lambda + EventBridge Scheduler** | `lambda/scheduled.js`. The IAM role has no SES, SNS or payment permissions. |

## Financial safeguards and where they are enforced

| Safeguard | Enforcement |
|---|---|
| Recorded data is authoritative | `engine/core.js` `balances()` uses only verified payments. In SQL, the `invoice_balances` view does the same. |
| No paid status without confirmation | Paid status is derived and never stored. `POST /api/invoices/:id/mark-paid` always returns 409. Payment verification needs a reviewer, a bank reference and explicit confirmation (`verified_requires_evidence` constraint). |
| No payment initiation | No code path or IAM permission for moving money. |
| No automatic sending | Drafts start as `pending_approval`. Approval needs a named reviewer, `confirm: true`, and `acknowledgeSensitive` for dispute-aware, firm or escalated tones. There is no send integration: staff send from their mailbox and record it. `business_rules.auto_send_reminders` has `CHECK (= false)`. |
| No invented numbers | `engine/reminders.js` `validateDraft()` blocks any dollar amount that is not in the allowed facts list. It also blocks claims that a payment was received, and legal or collections threats. |
| Estimate vs verified | `estimatePaymentTiming()` returns `kind: 'estimate' \| 'verified'`. The UI renders the two differently (dashed teal vs solid green) and labels estimates "not verified". |
| Audit | `activity_log` is append-only (update and delete rules). |

## AI modes

- `AI_MODE=demo` (default): deterministic rules or template engines stand in for Bedrock and Textract. Nothing leaves the machine.
- `AI_MODE=aws`: set `AWS_REGION`, `BEDROCK_MODEL_ID`, `INVOICE_BUCKET` and `INVOICE_KMS_KEY_ID`, and install the optional `@aws-sdk/*` packages. Any failure falls back to the rules engine, and the output label says so.

## Classification order

1. **Requires review**: extraction or total mismatch, unconfirmed payment claim, or overpayment.
2. **Disputed**: open dispute.
3. **Awaiting information**: open information request.
4. **Overdue**: past due with a verified balance.
5. **Current**: not yet due.
6. **Paid**: verified payments cover the total.

`overdue`, `disputed`, `partially_paid` and `unconfirmed_payment` are also kept as flags, so a disputed invoice still shows that it is overdue.

## Security notes for production

- Cognito or SAML SSO, and per-tenant `app.tenant_id` with Postgres RLS.
- Bedrock calls through a VPC endpoint (PrivateLink), with the role scoped to one model ID.
- Secrets in Secrets Manager. TLS everywhere. CloudTrail plus S3 Object Lock for evidence retention.
