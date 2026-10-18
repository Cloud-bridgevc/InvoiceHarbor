const $ = (s, el = document) => el.querySelector(s);

// ---------- Interactive invoice workflow ----------
const STEPS = [
  { t: 'Ingest', s: 'Invoice PDF lands in S3', svc: 'Amazon S3 · KMS encrypted',
    h: 'A supplier invoice arrives', p: 'INV-2026-1007 for Cedar & Pike Distribution is uploaded from the ERP export. The PDF is stored privately per tenant and an extraction job is queued.',
    card: `<table><tbody><tr><td class="muted">Object</td><td class="mono">s3://invoiceharbor-docs-…/2026/07/INV-2026-1007.pdf</td></tr><tr><td class="muted">Encryption</td><td>SSE-KMS, tenant key</td></tr><tr><td class="muted">Status</td><td><span class="badge awaiting_information">Queued for extraction</span></td></tr></tbody></table>` },
  { t: 'Extract', s: 'Fields & line items read', svc: 'Amazon Textract · AnalyzeExpense',
    h: 'Fields extracted, then checked', p: 'Textract reads the header fields and line items. InvoiceHarbor checks the arithmetic and matches the customer before a person confirms the record.',
    card: `<table><tbody><tr><td>Invoice no.</td><td class="strong">INV-2026-1007</td><td class="small muted">99%</td></tr><tr><td>Customer</td><td class="strong">Cedar &amp; Pike Distribution</td><td class="small muted">96%</td></tr><tr><td>Terms / due</td><td class="strong">Net 45 · Sep 10, 2026</td><td class="small muted">95%</td></tr><tr><td>Line items</td><td class="strong">200 × stretch film, 40 × edge protectors, freight</td><td class="small muted">94%</td></tr><tr><td>Total</td><td class="strong">$10,158.20</td><td class="small" style="color:var(--green-700)">✓ ties to lines + tax</td></tr></tbody></table>` },
  { t: 'Classify', s: 'Status from verified records', svc: 'Rules engine · PostgreSQL',
    h: 'Classified as disputed, and overdue too', p: 'No verified payments have been received. The due date passed 38 days ago, and an open dispute exists. Because the dispute takes precedence, the invoice goes to resolution rather than routine collections.',
    card: `<div style="display:flex;gap:6px;margin-bottom:10px"><span class="badge disputed">Disputed</span><span class="tag warn">38d overdue</span></div><table><tbody><tr><td>Recorded total</td><td class="r">$10,158.20</td></tr><tr><td>Verified payments</td><td class="r">$0.00</td></tr><tr><td class="strong">Verified balance</td><td class="r strong">$10,158.20</td></tr><tr><td>Open dispute DSP-301</td><td class="r">$901.00</td></tr></tbody></table>` },
  { t: 'Understand', s: 'Dispute thread summarised', svc: 'Amazon Bedrock',
    h: 'What the customer actually needs', p: 'Bedrock summarises three emails. The figures come from the dispute record, not from the model.',
    card: `<p style="margin:0 0 8px">Customer counted <b>180 of 200 rolls</b> and wants a credit note for 20. They are <b>holding the full invoice</b> and have followed up once.</p><div class="small"><b>Missing:</b> signed proof of delivery, carrier bill of lading<br /><b>Unanswered:</b> “Is there an update on the carrier paperwork?” · “What is the timeline for the credit note?”<br /><b>Next step:</b> request the undisputed $9,257.20 while confirming the shipped quantity</div>` },
  { t: 'Prioritize', s: 'Transparent scoring', svc: 'Configurable business rules',
    h: 'Ranked with every factor visible', p: 'There is no black-box score. Each factor and its points are shown, and the weights are set by your team.',
    card: `<table><tbody><tr><td>Overdue duration (38 days)</td><td class="r">+12.7</td></tr><tr><td>Verified balance ($10,158.20)</td><td class="r">+12.7</td></tr><tr><td>Open dispute</td><td class="r">+15.0</td></tr><tr><td>Key account rule</td><td class="r">+5.0</td></tr><tr><td class="strong">Priority score</td><td class="r strong">45.4</td></tr></tbody></table><p class="small muted" style="margin:8px 0 0">Recommended: advance the dispute and request the undisputed portion.</p>` },
  { t: 'Draft & approve', s: 'Reminder held for review', svc: 'Bedrock + amount validation + human approval',
    h: 'A dispute-aware draft, waiting for approval', p: 'The draft acknowledges the dispute, asks only for the undisputed amount, and passes amount validation. It is marked sensitive, so the approver must acknowledge that. InvoiceHarbor never sends it.',
    card: `<div class="small muted">To: Marcus Lindqvist · Dispute-aware · <b style="color:var(--st-disputed-fg)">sensitive</b></div><p style="margin:8px 0;white-space:pre-line">Hi Marcus,\n\nThank you for your patience regarding INV-2026-1007… Our team is gathering the delivery documentation so we can confirm the shipped quantity.\n\nWhile we resolve that question, would you be able to release the undisputed portion of <b>$9,257.20</b>? We will treat the remaining <b>$901.00</b> separately once the review is complete.</p><div class="small" style="color:var(--green-700)">✓ $9,257.20 = verified balance − disputed amount · ✓ $901.00 = dispute record</div><div style="margin-top:10px;display:flex;gap:8px"><span class="badge awaiting_information">Pending approval</span><span class="badge neutral">Not sent</span></div>` },
];
let cur = 0; let timer = null;
function renderWf() {
  $('#wfSteps').innerHTML = STEPS.map((st, i) => `<button class="wf-step ${i === cur ? 'on' : ''} ${i < cur ? 'done' : ''}" data-i="${i}" aria-pressed="${i === cur}"><span class="n">${i < cur ? '✓' : i + 1}</span><span><b>${st.t}</b><small>${st.s}</small></span></button>`).join('');
  const st = STEPS[cur];
  $('#wfPanel').innerHTML = `<div class="fade-in"><div class="svc">${st.svc}</div><h3>${st.h}</h3><p>${st.p}</p><div class="wf-card">${st.card}</div>
    <div class="wf-controls"><button data-nav="-1" ${cur === 0 ? 'disabled' : ''}>← Previous</button><button data-nav="1">${cur === STEPS.length - 1 ? 'Restart' : 'Next step →'}</button><button data-play>${timer ? 'Pause' : 'Auto-play'}</button><a href="/app#/demo" style="margin-left:auto;color:var(--teal-300);font-size:13px;align-self:center">Try it in the workspace →</a></div></div>`;
}
$('#wfSteps').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) { cur = +b.dataset.i; stop(); renderWf(); } });
$('#wfPanel').addEventListener('click', (e) => {
  const n = e.target.closest('[data-nav]');
  if (n) { cur = (cur + Number(n.dataset.nav) + STEPS.length) % STEPS.length; stop(); renderWf(); }
  if (e.target.closest('[data-play]')) { timer ? stop() : (timer = setInterval(() => { cur = (cur + 1) % STEPS.length; renderWf(); }, 4200)); renderWf(); }
});
const stop = () => { clearInterval(timer); timer = null; };
renderWf();

// ---------- Use cases ----------
const UC = {
  agency: { h: 'Agencies & creative studios', p: 'Retainers, change orders and PO-gated clients create disputes that are really documentation gaps. InvoiceHarbor shows what is missing before you chase anyone.',
    li: ['Flags invoices that are blocked on PO numbers or approvals and labels them “awaiting information”', 'Summarises scope disputes against SOWs and change orders', 'Drafts courteous reminders that protect client relationships', 'Separates retainer versus project receivables in reporting'],
    q: [['Typical blocker', 'Missing PO / approval'], ['Classification', 'Awaiting information'], ['Recommended action', 'Send requested PO details'], ['Reminder tone', 'Information response']] },
  distributor: { h: 'Distributors & wholesalers', p: 'High invoice volumes, short shipments and partial payments. InvoiceHarbor reconciles what was paid, what is disputed and what is genuinely late.',
    li: ['Extracts line-level quantities so shortfall disputes are scoped exactly', 'Requests the undisputed portion while quantity questions are resolved', 'Matches bank-feed deposits to invoices using amount, PO and remitter', 'Tracks broken promises to pay and escalates tone appropriately'],
    q: [['Typical blocker', 'Quantity shortfall'], ['Classification', 'Disputed · overdue'], ['Recommended action', 'Request undisputed portion'], ['Reminder tone', 'Dispute-aware']] },
};
function renderUc(k) {
  const u = UC[k];
  $('#ucPanel').innerHTML = `<div class="usecase fade-in"><div><h3>${u.h}</h3><p style="color:var(--ink-2)">${u.p}</p><ul>${u.li.map((l) => `<li>${l}</li>`).join('')}</ul></div><div class="quote-card">${u.q.map(([a, b]) => `<div class="row2"><span class="muted">${a}</span><b>${b}</b></div>`).join('')}</div></div>`;
  document.querySelectorAll('[data-uc]').forEach((b) => { b.classList.toggle('on', b.dataset.uc === k); b.setAttribute('aria-selected', b.dataset.uc === k); });
}
document.querySelectorAll('[data-uc]').forEach((b) => b.onclick = () => renderUc(b.dataset.uc));
renderUc('agency');

// ---------- Pricing toggle ----------
const sw = $('#billingSwitch');
function renderPrices() {
  const annual = sw.getAttribute('aria-checked') === 'true';
  document.querySelectorAll('.price[data-m]').forEach((el) => {
    const m = Number(el.dataset.m);
    const v = annual ? Math.round(m * 0.85) : m;
    el.innerHTML = `$${v.toLocaleString('en-US')}<small> /mo${annual ? ', billed annually' : ''}</small>`;
  });
}
sw.onclick = () => { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') !== 'true'); renderPrices(); };
renderPrices();

// ---------- Mobile menu ----------
$('#menuBtn').onclick = () => $('#siteNav').classList.toggle('open');
$('#siteNav').addEventListener('click', (e) => { if (e.target.tagName === 'A') $('#siteNav').classList.remove('open'); });

// ---------- Demo request ----------
$('#demoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#formMsg');
  const data = Object.fromEntries(new FormData(f));
  data.consent = f.consent.checked;
  if (!data.name.trim() || !data.company.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) {
    msg.className = 'form-msg err'; msg.textContent = 'Please add your name, company and a valid work email.'; return;
  }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/demo-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    msg.className = 'form-msg ok'; msg.textContent = `Thanks, ${data.name.split(' ')[0]}. Your request (${out.id}) was received, and our team will be in touch to schedule a time.`;
    f.reset();
  } catch (err) {
    msg.className = 'form-msg err'; msg.textContent = err.message || 'Something went wrong. Please try again.';
  } finally { btn.disabled = false; }
});
