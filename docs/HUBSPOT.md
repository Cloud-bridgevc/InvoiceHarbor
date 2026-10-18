# HubSpot integration plan

HubSpot is InvoiceHarbor's **go-to-market system**. It is used for prospects, demo booking, onboarding and the sales pipeline. It is **not** a home for receivables data.

## Principle: financial and marketing data stay separate

| Data | System | Notes |
|---|---|---|
| Website demo requests, prospects, marketing consent | HubSpot (via the separate marketing store) | `POST /api/demo-requests` writes to a separate store and never to the `ar` schema. |
| Sales pipeline, deals, onboarding tasks | HubSpot | |
| Invoices, payments, disputes, customer balances, reminders | InvoiceHarbor PostgreSQL only | Never synchronized to HubSpot by default. |

Limited synchronization is allowed only when an **authorized integration explicitly requires it**. That means an admin enables it per tenant, the scope is documented, and the minimal field allow-list below is used.

## 1. Prospect management
- The website form becomes a HubSpot **Contact** plus **Company** (Forms API or `crm/v3/objects/contacts`), with `lifecyclestage=lead`.
- Fields: name, work email, company, role, business type, invoice volume band, message, and marketing consent (a separate legal basis). The form tells users not to include financial details.
- Dedupe on email domain to the Company. Lead score uses segment and volume band.

## 2. Demo booking
- Qualified leads get a HubSpot **Meetings** link (round-robin across AEs).
- Meeting booked: the Deal moves to stage **Demo scheduled**. Demos always use the fictional demo tenant.

## 3. Sales pipeline: "InvoiceHarbor Sales"
`Demo requested → Demo scheduled → Demo completed → Security review → Proposal → Contract sent → Closed won / Closed lost`
- Deal properties: plan (Essentials/Growth/Enterprise), open-invoice band, ERP, region, and security review status.

## 4. Customer onboarding
- Closed won creates an onboarding **Ticket pipeline**: `Kickoff → SSO configured → ERP import → Bank feed connected → Rules configured → Go-live`.
- InvoiceHarbor sends **operational milestones only** back to HubSpot through a private app token: `ih_tenant_id`, `ih_onboarding_stage`, `ih_go_live_date`, `ih_active_users`, `ih_plan`.
- **Never synchronized:** invoice amounts, balances, customer names of the tenant's own debtors, dispute content, payment records or reminder text.

## Technical design
- One-way, event-driven sync: InvoiceHarbor writes to an SQS queue, then a Lambda calls the HubSpot CRM v3 API. The Lambda's role cannot read the `ar` schema. It only receives allow-listed payloads.
- The allow-list is enforced in code (schema validation) and is reviewable. Any new field needs a security sign-off.
- HubSpot webhooks (deal stage changes) go to a Lambda that provisions or updates the **tenant record** (plan, seats). It never touches receivables tables.
- Token stored in Secrets Manager with least-scope (`crm.objects.contacts.write`, `crm.objects.deals.write`, `tickets`).
- Consent: honour HubSpot subscription status, and keep an audit of every sync payload.
