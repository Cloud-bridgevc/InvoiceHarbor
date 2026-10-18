# InvoiceHarbor

An AI-native accounts receivable coordination and invoice intelligence platform. This is a demonstration build that runs on fictional data.

```bash
npm start            # http://localhost:4310  (website at /, workspace at /app)
npm test             # safeguard and engine tests
node lambda/scheduled.js nightlyAging   # run a scheduled task locally
```

No dependencies are required in demo mode (Node 20+). To run with AWS services, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#ai-modes).

## What's here

| Path | Contents |
|---|---|
| `public/index.html` | Marketing website: interactive invoice workflow, platform, safeguards, agency/distributor use cases, pricing, demo request form, FAQ |
| `public/app.html` | Workspace: overview, invoice register, customers, aging, disputes, follow-up queue, draft reminder review, payment reconciliation, extraction, reporting, activity, rules, guided demo |
| `server/engine/` | Classification, aging, transparent prioritization, payment-timing estimates, dispute intelligence, reminder drafting and validation, extraction checks |
| `server/aws/adapters.js` | Amazon Bedrock (Converse), Textract (AnalyzeExpense) and S3 adapters |
| `server/data/seed.js` | Fictional customers, invoices, payments, disputes, sample documents |
| `db/schema.sql` | PostgreSQL schema with safeguard constraints |
| `lambda/scheduled.js`, `infra/template.yaml` | Scheduled Lambda tasks and a reference SAM template |
| `docs/` | Architecture, safeguards and the HubSpot integration plan |

## The demonstration

Open **/app#/demo**. **INV-2026-1007** (Cedar & Pike Distribution) is 38 days overdue. The customer disputes $901.00 for 20 missing rolls, and is holding the full $10,158.20.

1. **Identify:** the invoice is classified as *Disputed* and flagged *38d overdue*, with the reasons spelled out.
2. **Understand:** a dispute summary that shows the missing proof of delivery and bill of lading, two unanswered questions, and next steps.
3. **Prioritize:** a score of 45.4, with each factor's points shown.
4. **Draft:** a dispute-aware reminder that asks only for the undisputed **$9,257.20**. Every amount is validated, and the draft is flagged sensitive. It stays pending until a named reviewer approves it, and it is never sent by the system.

You can also try:
- **Mark as paid…** on any invoice. It is refused, because paid status comes only from verified payments.
- **Reconciliation.** Verify the Solenne remittance claim (it needs a bank reference), or apply the unapplied Quayside deposit.
- **Draft reminder review.** Edit a draft to include a made-up amount like `$5,000.00`, and approval is blocked.
- **Extraction.** Sample C has an OCR error and a total mismatch, so the record is routed to review.

All companies, people, invoices and amounts are fictional.
