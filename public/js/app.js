// InvoiceHarbor receivables workspace (vanilla JS SPA).
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n) => '$' + Math.round(Number(n)).toLocaleString('en-US');
const dt = (iso) => iso ? new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
const dtt = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const REVIEWER_KEY = 'ih.reviewer';
let reviewer = (() => { try { return localStorage.getItem(REVIEWER_KEY) || 'J. Whitfield'; } catch { return 'J. Whitfield'; } })();

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 4000);
}
const badge = (c) => `<span class="badge ${c.class}">${esc(c.label)}</span>`;
const flagTags = (c) => c.flags.filter((f) => f !== c.class).map((f) => `<span class="tag ${f === 'overdue' ? 'warn' : ''}">${f === 'overdue' ? `${c.daysOverdue}d overdue` : f.replace(/_/g, ' ')}</span>`).join('');

// ---------- Confirmation modal (every consequential action goes through here) ----------
function confirmModal({ title, body, confirmLabel = 'Confirm', checks = [], fields = [] }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
      <h2 id="mt">${esc(title)}</h2><div class="small" style="color:var(--ink-2)">${body}</div>
      <label class="f" for="m-rev">Reviewer (recorded in audit trail)</label><input type="text" id="m-rev" value="${esc(reviewer)}" />
      ${fields.map((f) => `<label class="f" for="m-${f.key}">${esc(f.label)}</label><input type="text" id="m-${f.key}" placeholder="${esc(f.placeholder || '')}" />`).join('')}
      ${checks.map((c, i) => `<label class="check"><input type="checkbox" data-i="${i}" /> <span>${c}</span></label>`).join('')}
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok disabled>${esc(confirmLabel)}</button></div></div>`;
    document.body.appendChild(bg);
    const ok = $('[data-ok]', bg);
    const update = () => {
      const allChecked = [...bg.querySelectorAll('input[type=checkbox]')].every((x) => x.checked);
      const filled = $('#m-rev', bg).value.trim() && fields.every((f) => $('#m-' + f.key, bg).value.trim());
      ok.disabled = !(allChecked && filled);
    };
    bg.addEventListener('input', update);
    update();
    const close = (v) => { bg.remove(); resolve(v); };
    $('[data-x]', bg).onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    ok.onclick = () => {
      reviewer = $('#m-rev', bg).value.trim();
      try { localStorage.setItem(REVIEWER_KEY, reviewer); } catch {}
      close({ reviewer, values: Object.fromEntries(fields.map((f) => [f.key, $('#m-' + f.key, bg).value.trim()])) });
    };
  });
}

// ---------- Tooltip for chart marks ----------
const tip = document.createElement('div');
tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip);
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = e.clientY + 14 + 'px';
});

const AGE_COLORS = { 'Current': 'var(--age-0)', '1–30': 'var(--age-1)', '31–60': 'var(--age-2)', '61–90': 'var(--age-3)', '90+': 'var(--age-4)' };
function agingBar(totals) {
  const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  return `<div class="stack" role="img" aria-label="Aging distribution">${Object.entries(totals).filter(([, v]) => v > 0).map(([k, v]) => `<span style="width:${(v / sum) * 100}%;background:${AGE_COLORS[k]}" data-tip="${k}: ${usd(v)} (${Math.round((v / sum) * 100)}%)"></span>`).join('')}</div>
    <div class="legend">${Object.entries(totals).map(([k, v]) => `<span><i style="background:${AGE_COLORS[k]}"></i>${k} <b class="num">${usd0(v)}</b></span>`).join('')}</div>`;
}
function factorList(p) {
  const max = Math.max(...p.factors.map((f) => Math.abs(f.points)), 1);
  return p.factors.map((f) => `<div class="factor ${f.points < 0 ? 'neg' : ''}"><div><b>${esc(f.label)}</b> <span class="muted">— ${esc(f.detail)}</span></div><div class="r num strong" style="text-align:right">${f.points > 0 ? '+' : ''}${f.points.toFixed(1)}</div><div class="bar"><span style="width:${(Math.abs(f.points) / max) * 100}%"></span></div></div>`).join('');
}
function timingBox(t) {
  if (t.kind === 'verified') return `<div class="verified"><div class="k">✓ Verified payment</div><div class="strong">${dt(t.date)}</div><div class="small muted">${esc(t.basis)}</div></div>`;
  return `<div class="est"><div class="k">Estimate · not verified</div><div class="strong">${t.date ? 'Around ' + dt(t.date) : 'No estimate'}${t.confidence && t.confidence !== 'none' ? ` <span class="small muted">(${t.confidence} confidence)</span>` : ''}</div><div class="small muted">${esc(t.basis)}</div></div>`;
}

// ---------- Navigation ----------
const NAV = [
  ['Workspace', [['overview', 'Overview'], ['invoices', 'Invoice register'], ['customers', 'Customers'], ['aging', 'Aging analysis']]],
  ['Collections', [['queue', 'Follow-up queue', 'queue'], ['disputes', 'Disputes', 'disputes'], ['reminders', 'Draft reminders', 'drafts']]],
  ['Cash', [['reconciliation', 'Payment reconciliation', 'recon'], ['extraction', 'Invoice extraction']]],
  ['Insight', [['reports', 'Reporting'], ['activity', 'Activity history'], ['settings', 'Rules & safeguards'], ['demo', 'Guided demo']]],
];
let counts = {};
function renderNav(active) {
  $('#nav').innerHTML = NAV.map(([g, items]) => `<div class="nav-group">${g}</div>` + items.map(([k, label, c]) => `<a href="#/${k}" class="${active === k ? 'active' : ''}">${label}${c && counts[c] ? `<span class="count">${counts[c]}</span>` : ''}</a>`).join('')).join('');
}
async function refreshCounts() {
  const o = await api('/overview');
  counts = { queue: o.topQueue.length ? (await api('/queue')).length : 0, disputes: o.byClass.find((b) => b.class === 'disputed').count, drafts: o.kpis.pendingDrafts, recon: (o.kpis.unconfirmed > 0) + (o.kpis.unapplied > 0) };
  $('#asOf').textContent = 'Records as of ' + dt(o.asOf);
  $('#modePill').textContent = o.mode === 'aws' ? 'AWS mode · sending disabled' : 'Demo mode · sending disabled';
}

// ---------- Views ----------
const views = {};

views.overview = async () => {
  const o = await api('/overview');
  const k = o.kpis;
  const maxClass = Math.max(...o.byClass.map((b) => b.amount), 1);
  return `<h1 class="page">Accounts receivable overview</h1><p class="subtitle">All balances are recorded invoice totals minus <b>verified</b> payments. Unconfirmed remittances never reduce a balance.</p>
  <div class="notice"><span>◆</span><div><b>Demo spotlight:</b> INV-2026-1007 (Cedar &amp; Pike) is both disputed and overdue. <a href="#/demo">Walk through how InvoiceHarbor identifies it and prepares a reminder for review →</a></div></div>
  <div class="grid g-5">
    <div class="card kpi accent"><div class="label">Outstanding (verified)</div><div class="value">${usd(k.outstanding)}</div><div class="foot">${k.openInvoices} open invoices</div></div>
    <div class="card kpi"><div class="label">Past due</div><div class="value">${usd(k.overdue)}</div><div class="foot">${k.overduePct}% of outstanding · avg ${k.weightedDaysOverdue}d</div></div>
    <div class="card kpi"><div class="label">Under dispute</div><div class="value">${usd(k.disputed)}</div><div class="foot">disputed portions only</div></div>
    <div class="card kpi"><div class="label">Unconfirmed payments</div><div class="value">${usd(k.unconfirmed)}</div><div class="foot">claimed, not yet in bank — excluded</div></div>
    <div class="card kpi"><div class="label">Drafts awaiting approval</div><div class="value">${k.pendingDrafts}</div><div class="foot"><a href="#/reminders">Review drafts</a></div></div>
  </div>
  <div class="grid g-main" style="margin-top:16px">
    <div class="grid">
      <div class="card"><div class="card-head"><h2>Aging</h2><a class="small" href="#/aging">Full analysis →</a></div>${agingBar(o.aging)}</div>
      <div class="card flush"><div class="card-head" style="padding:16px 18px 0"><h2>Top of the follow-up queue</h2><a class="small" href="#/queue">Open queue →</a></div>
        <table><thead><tr><th>#</th><th>Invoice</th><th>Status</th><th class="r">Balance</th><th class="r">Score</th><th>Recommended</th></tr></thead><tbody>
        ${o.topQueue.map((q) => `<tr class="click" data-href="#/invoices/${q.invoiceId}"><td>${q.rank}</td><td><b>${q.number}</b><div class="small muted">${esc(q.customerName)}</div></td><td>${badge(q.classification)} ${flagTags(q.classification)}</td><td class="r">${usd(q.classification.balance)}</td><td class="r strong">${q.priority.score.toFixed(1)}</td><td class="small">${esc(q.priority.recommendedAction.label)}</td></tr>`).join('')}
        </tbody></table></div>
    </div>
    <div class="grid" style="align-content:start">
      <div class="card"><h2>Receivables classification</h2>${o.byClass.map((b) => `<div class="hbar"><span>${badge(b)} </span><div class="track"><div class="fill" style="width:${(b.amount / maxClass) * 100}%" data-tip="${b.label}: ${b.count} invoices, ${usd(b.amount)}"></div></div><span class="r num small">${b.count} · ${usd0(b.amount)}</span></div>`).join('')}
        <p class="small muted" style="margin:8px 0 0">Paid amount shows remaining balance ($0) by design.</p></div>
      <div class="card"><div class="card-head"><h2>Recent activity</h2><a class="small" href="#/activity">All →</a></div><div class="timeline">${o.recentActivity.map((a) => `<div class="tl"><div class="t">${dtt(a.at)} · ${esc(a.actor)}</div><div class="small">${esc(a.message)}</div></div>`).join('')}</div></div>
    </div>
  </div>`;
};

const CLASS_FILTERS = [['', 'All'], ['current', 'Current'], ['overdue', 'Overdue'], ['disputed', 'Disputed'], ['awaiting_information', 'Awaiting info'], ['requires_review', 'Requires review'], ['partially_paid', 'Partially paid'], ['paid', 'Paid']];
views.invoices = async (params, query) => {
  const cls = query.get('class') || '';
  const q = query.get('q') || '';
  const list = await api(`/invoices?${new URLSearchParams({ ...(cls && { class: cls }), ...(q && { q }) })}`);
  return `<h1 class="page">Invoice register</h1><p class="subtitle">${list.length} invoice${list.length === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}. Status is classified from recorded invoice and payment data.</p>
  <div class="chips">${CLASS_FILTERS.map(([k, l]) => `<a class="chip ${cls === k ? 'on' : ''}" href="#/invoices${k ? '?class=' + k : ''}">${l}</a>`).join('')}</div>
  <div class="card flush"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th class="r">Total</th><th class="r">Verified balance</th><th>Payment timing</th></tr></thead><tbody>
  ${list.map((i) => `<tr class="click" data-href="#/invoices/${i.id}"><td><b>${i.number}</b><div class="small muted">PO ${esc(i.poNumber || '—')}</div></td><td>${esc(i.customerName)}</td><td class="num">${dt(i.issueDate)}</td><td class="num">${dt(i.dueDate)}</td><td>${badge(i.classification)}<div>${flagTags(i.classification)}</div></td><td class="r">${usd(i.total)}</td><td class="r strong">${usd(i.classification.balance)}${i.classification.unconfirmedClaimed ? `<div class="small muted">${usd(i.classification.unconfirmedClaimed)} unconfirmed</div>` : ''}</td>
    <td class="small">${i.paymentTiming.kind === 'verified' ? `<span style="color:var(--green-700)">✓ Paid ${dt(i.paymentTiming.date)}</span>` : i.paymentTiming.date ? `<span class="muted">Est. ~${dt(i.paymentTiming.date)}</span>` : '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No invoices match.</td></tr>'}
  </tbody></table></div>`;
};

views.invoice = async ({ id }) => {
  const i = await api('/invoices/' + encodeURIComponent(id));
  const c = i.classification;
  return `<div class="row" style="margin-bottom:6px"><a href="#/invoices" class="small">← Invoice register</a></div>
  <div class="row" style="justify-content:space-between;margin-bottom:18px"><div><h1 class="page">${i.number} ${badge(c)} ${flagTags(c)}</h1><div class="muted"><a href="#/customers/${i.customerId}">${esc(i.customerName)}</a> · PO ${esc(i.poNumber || 'not provided')} · ${i.paymentTerms} · source: ${i.source.replace(/_/g, ' ')}</div></div>
    <div class="row no-print">${c.class !== 'paid' && c.class !== 'requires_review' ? `<button class="btn primary" data-act="draft" data-id="${i.id}">Draft reminder for review</button>` : ''}${i.dispute ? `<a class="btn" href="#/disputes/${i.dispute.id}">Open dispute ${i.dispute.id}</a>` : ''}<button class="btn" data-act="markpaid" data-id="${i.id}">Mark as paid…</button></div></div>
  <div class="grid g-main">
    <div class="grid" style="align-content:start">
      <div class="card"><h2>Why this classification</h2><ul class="clean">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>
      ${i.priority ? `<div class="card"><div class="card-head"><h2>Follow-up priority</h2><div class="score">${i.priority.score.toFixed(1)}</div></div>${factorList(i.priority)}<p class="small muted" style="margin:10px 0 0">Recommended: <b>${esc(i.priority.recommendedAction.label)}</b>. Weights are configurable in <a href="#/settings">Rules &amp; safeguards</a>.</p></div>` : ''}
      <div class="card flush"><div style="padding:16px 18px 0"><h2>Line items</h2></div><table><thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead><tbody>
        ${i.lineItems.map((l) => `<tr><td>${l.line}</td><td>${esc(l.description)}</td><td class="r">${l.quantity}</td><td class="r">${usd(l.unitPrice)}</td><td class="r">${usd(l.amount)}</td></tr>`).join('')}
        <tr><td colspan="4" class="r muted">Subtotal</td><td class="r">${usd(i.subtotal)}</td></tr><tr><td colspan="4" class="r muted">Tax</td><td class="r">${usd(i.tax)}</td></tr><tr><td colspan="4" class="r strong">Recorded total</td><td class="r strong">${usd(i.total)}</td></tr></tbody></table></div>
      <div class="card"><h2>Activity</h2>${i.activity.length ? `<div class="timeline">${i.activity.map((a) => `<div class="tl"><div class="t">${dtt(a.at)} · ${esc(a.actor)}</div><div class="small">${esc(a.message)}</div></div>`).join('')}</div>` : '<p class="muted small">No activity yet.</p>'}</div>
    </div>
    <div class="grid" style="align-content:start">
      <div class="card"><h2>Amounts</h2><dl class="kv"><dt>Recorded total</dt><dd>${usd(c.total)}</dd><dt>Verified payments</dt><dd>− ${usd(c.verifiedPaid)}</dd><dt>Verified balance</dt><dd class="total">${usd(c.balance)}</dd>
        ${c.unconfirmedClaimed ? `<dt>Unconfirmed claim</dt><dd class="muted">${usd(c.unconfirmedClaimed)} <span class="small">(not deducted)</span></dd>` : ''}
        ${i.dispute ? `<dt>Disputed portion</dt><dd>${usd(i.dispute.disputedAmount)}</dd><dt>Undisputed</dt><dd>${usd(c.balance - i.dispute.disputedAmount)}</dd>` : ''}
        <dt>Issued</dt><dd>${dt(i.issueDate)}</dd><dt>Due</dt><dd>${dt(i.dueDate)}</dd>${c.daysOverdue && c.class !== 'paid' ? `<dt>Days past due</dt><dd>${c.daysOverdue}</dd>` : ''}</dl></div>
      <div class="card"><h2>Payment timing</h2>${timingBox(i.paymentTiming)}</div>
      <div class="card"><h2>Payments</h2>${i.payments.length ? `<ul class="clean">${i.payments.map((p) => `<li><div class="row" style="justify-content:space-between"><b>${usd(p.amount)}</b><span class="badge ${p.status === 'verified' ? 'current' : p.status === 'unconfirmed' ? 'requires_review' : 'neutral'}">${p.status}</span></div><div class="small muted">${dt(p.receivedDate)} · ${esc(p.method)} · ${esc(p.reference)}${p.verifiedBy ? ` · verified by ${esc(p.verifiedBy)}` : ''}</div></li>`).join('')}</ul>` : '<p class="small muted">No payments recorded.</p>'}</div>
      ${i.infoRequests.length ? `<div class="card"><h2>Information requests</h2>${i.infoRequests.map((r) => `<div class="small"><b>${esc(r.item)}</b> <span class="badge neutral">${r.status}</span><p class="muted">${esc(r.detail)}</p></div>`).join('')}</div>` : ''}
      ${i.promises.length ? `<div class="card"><h2>Promises to pay</h2>${i.promises.map((p) => `<div class="small"><b>${usd(p.amount)}</b> by ${dt(p.promisedDate)} <span class="badge ${p.status === 'broken' ? 'overdue' : 'neutral'}">${p.status}</span><div class="muted">Recorded by ${esc(p.recordedBy)} — a customer promise is not a verified payment.</div></div>`).join('')}</div>` : ''}
      <div class="card"><h2>Reminders</h2>${i.reminders.length ? `<ul class="clean">${i.reminders.map((r) => `<li><a href="#/reminders/${r.id}">${r.id}</a> · ${esc(r.subject)}<div class="small muted">${r.status.replace(/_/g, ' ')} · ${dtt(r.createdAt)}</div></li>`).join('')}</ul>` : '<p class="small muted">None yet.</p>'}</div>
    </div>
  </div>`;
};

views.customers = async () => {
  const list = await api('/customers');
  return `<h1 class="page">Customer records</h1><p class="subtitle">Financial account data only. Prospect and marketing data live in HubSpot and are never merged here.</p>
  <div class="card flush"><table><thead><tr><th>Customer</th><th>Segment</th><th>AP contact</th><th>Terms</th><th class="r">Open</th><th class="r">Outstanding</th><th class="r">Past due</th><th class="r">Disputes</th><th class="r">Credit used</th></tr></thead><tbody>
  ${list.map((c) => `<tr class="click" data-href="#/customers/${c.id}"><td><b>${esc(c.name)}</b>${c.keyAccount ? ' <span class="tag">key account</span>' : ''}<div class="small muted">${c.id} · ${esc(c.region)}</div></td><td>${esc(c.segment)}</td><td>${esc(c.contact.name)}<div class="small muted">${esc(c.contact.role)}</div></td><td>Net ${c.termsDays}</td><td class="r">${c.openInvoices}</td><td class="r strong">${usd(c.outstanding)}</td><td class="r">${c.overdue ? usd(c.overdue) : '—'}</td><td class="r">${c.openDisputes || '—'}</td><td class="r">${c.utilization != null ? Math.round(c.utilization * 100) + '%' : '—'}</td></tr>`).join('')}
  </tbody></table></div>`;
};

views.customer = async ({ id }) => {
  const c = await api('/customers/' + id);
  return `<div class="row" style="margin-bottom:6px"><a href="#/customers" class="small">← Customers</a></div>
  <h1 class="page">${esc(c.name)}</h1><p class="subtitle">${c.segment} · ${esc(c.region)} · Net ${c.termsDays} · AP: ${esc(c.contact.name)} (${esc(c.contact.email)})</p>
  <div class="grid g-5"><div class="card kpi accent"><div class="label">Outstanding</div><div class="value">${usd(c.outstanding)}</div></div><div class="card kpi"><div class="label">Past due</div><div class="value">${usd(c.overdue)}</div></div><div class="card kpi"><div class="label">Credit limit used</div><div class="value">${Math.round(c.utilization * 100)}%</div><div class="foot">of ${usd0(c.creditLimit)}</div></div><div class="card kpi"><div class="label">Open disputes</div><div class="value">${c.openDisputes}</div></div><div class="card kpi"><div class="label">Unconfirmed</div><div class="value">${usd(c.unconfirmed)}</div></div></div>
  <div class="grid g-main" style="margin-top:16px"><div class="card flush"><table><thead><tr><th>Invoice</th><th>Due</th><th>Status</th><th class="r">Balance</th><th>Timing</th></tr></thead><tbody>
  ${c.invoices.map((i) => `<tr class="click" data-href="#/invoices/${i.id}"><td><b>${i.number}</b></td><td>${dt(i.dueDate)}</td><td>${badge(i.classification)} ${flagTags(i.classification)}</td><td class="r">${usd(i.classification.balance)}</td><td class="small">${i.paymentTiming.kind === 'verified' ? '✓ Verified ' + dt(i.paymentTiming.date) : i.paymentTiming.date ? 'Estimate ~' + dt(i.paymentTiming.date) : '—'}</td></tr>`).join('')}</tbody></table></div>
  <div class="card"><h2>Account activity</h2><div class="timeline">${c.activity.map((a) => `<div class="tl"><div class="t">${dtt(a.at)} · ${esc(a.actor)}</div><div class="small">${esc(a.message)}</div></div>`).join('') || '<p class="muted small">None.</p>'}</div></div></div>`;
};

views.aging = async () => {
  const a = await api('/aging');
  return `<h1 class="page">Aging analysis</h1><p class="subtitle">As of ${dt(a.asOf)}. ${esc(a.basis)}</p>
  <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>Portfolio aging</h2><span class="score">${usd(a.grandTotal)}</span></div>${agingBar(a.totals)}</div>
  <div class="card flush"><table><thead><tr><th>Customer</th>${a.buckets.map((b) => `<th class="r">${b}</th>`).join('')}<th class="r">Total</th><th style="width:180px">Mix</th></tr></thead><tbody>
  ${a.rows.sort((x, y) => y.total - x.total).map((r) => `<tr class="click" data-href="#/customers/${r.customerId}"><td><b>${esc(r.customerName)}</b></td>${a.buckets.map((b) => `<td class="r">${r.buckets[b] ? usd(r.buckets[b]) : '<span class="muted">—</span>'}</td>`).join('')}<td class="r strong">${usd(r.total)}</td><td><div class="stack" style="height:8px">${a.buckets.filter((b) => r.buckets[b]).map((b) => `<span style="width:${(r.buckets[b] / r.total) * 100}%;background:${AGE_COLORS[b]}" data-tip="${b}: ${usd(r.buckets[b])}"></span>`).join('')}</div></td></tr>`).join('')}
  <tr><td class="strong">Total</td>${a.buckets.map((b) => `<td class="r strong">${usd(a.totals[b])}</td>`).join('')}<td class="r strong">${usd(a.grandTotal)}</td><td></td></tr></tbody></table></div>`;
};

views.queue = async () => {
  const q = await api('/queue');
  return `<h1 class="page">Follow-up queue</h1><p class="subtitle">Ranked by transparent, configurable factors. Every point is explained — nothing is a black-box score.</p>
  <div class="card flush">${q.map((x) => `<div class="qitem"><div class="rank">${x.rank}</div>
    <div><a href="#/invoices/${x.invoiceId}" class="strong">${x.number}</a> · ${esc(x.customerName)}<div style="margin:4px 0">${badge(x.classification)} ${flagTags(x.classification)}</div><div class="small muted">${esc(x.classification.reasons[0])}</div></div>
    <div><div class="row" style="justify-content:space-between"><span class="small muted">Score</span><span class="score">${x.priority.score.toFixed(1)}</span></div>${factorList(x.priority)}</div>
    <div><div class="small muted">Verified balance</div><div class="strong num">${usd(x.classification.balance)}</div><div class="small" style="margin:6px 0">${esc(x.priority.recommendedAction.label)}</div>
      ${x.classification.class === 'requires_review' ? `<a class="btn sm" href="#/${x.classification.unconfirmedClaimed ? 'reconciliation' : 'invoices/' + x.invoiceId}">Review record</a>` : x.hasPendingDraft ? `<a class="btn sm" href="#/reminders">Draft pending</a>` : `<button class="btn sm primary" data-act="draft" data-id="${x.invoiceId}">Draft (${esc(x.suggestedTone)})</button>`}</div></div>`).join('')}</div>`;
};

views.disputes = async ({ id }) => {
  const list = await api('/disputes');
  const sel = list.find((d) => d.id === id) || list[0];
  if (sel && sel.status === 'open' && !sel.analysis) { sel.analysis = await api(`/disputes/${sel.id}/analyze`, { method: 'POST', body: { actor: 'System' } }); }
  const a = sel?.analysis;
  return `<h1 class="page">Dispute management</h1><p class="subtitle">Correspondence summaries, missing information, and next steps. Amounts come from dispute and payment records — never from the model.</p>
  <div class="list-pane"><div class="card flush">${list.map((d) => `<div class="list-item ${d.id === sel?.id ? 'on' : ''}" data-href="#/disputes/${d.id}"><div class="row" style="justify-content:space-between"><b>${d.id}</b><span class="badge ${d.status === 'open' ? 'disputed' : 'paid'}">${d.status}</span></div><div class="small">${d.invoiceNumber} · ${esc(d.customerName)}</div><div class="small muted">${d.category.replace(/_/g, ' ')} · ${usd(d.disputedAmount)} · ${d.daysOpen}d ${d.status === 'open' ? 'open' : 'to resolve'}${d.daysOverdue && d.status === 'open' ? ` · invoice ${d.daysOverdue}d overdue` : ''}</div></div>`).join('')}</div>
  ${sel ? `<div class="grid">
    <div class="card"><div class="card-head"><div><h2>${sel.id} — ${sel.category.replace(/_/g, ' ')}</h2><div class="small muted"><a href="#/invoices/${sel.invoiceId}">${sel.invoiceNumber}</a> · ${esc(sel.customerName)} · owner ${esc(sel.owner)}</div></div>
      ${sel.status === 'open' ? `<div class="row"><button class="btn" data-act="analyze" data-id="${sel.id}">Re-run analysis</button><button class="btn primary" data-act="draft" data-id="${sel.invoiceId}">Draft dispute-aware update</button></div>` : ''}</div>
      ${sel.status !== 'open' ? `<div class="notice"><div><b>Resolved ${dt(sel.resolvedDate)}.</b> ${esc(sel.resolution)}</div></div>` : ''}
      ${a ? `<div class="grid g-3" style="margin-bottom:14px"><div class="card kpi" style="box-shadow:none"><div class="label">Verified balance</div><div class="value">${usd(a.figures.balance)}</div></div><div class="card kpi" style="box-shadow:none"><div class="label">Disputed</div><div class="value">${usd(a.figures.disputedAmount)}</div></div><div class="card kpi" style="box-shadow:none"><div class="label">Undisputed</div><div class="value">${usd(a.figures.undisputedAmount)}</div></div></div>
      <h3>Summary</h3><p>${esc(a.summary)}</p>${a.signals.length ? `<ul class="clean">${a.signals.map((s) => `<li>• ${esc(s)}</li>`).join('')}</ul>` : ''}
      <p class="small muted">Generated by ${esc(a.generatorLabel)} · waiting on <b>${a.waitingOn === 'us' ? 'our team' : 'customer'}</b></p>` : ''}
    </div>
    ${a ? `<div class="grid g-3">
      <div class="card"><h3>Missing information</h3>${a.missingInformation.length ? `<ul class="clean">${a.missingInformation.map((m) => `<li>☐ ${esc(m.label)}</li>`).join('')}</ul>` : '<p class="small muted">All required evidence on file.</p>'}</div>
      <div class="card"><h3>Unresolved questions</h3><ul class="clean">${a.unresolvedQuestions.map((q) => `<li>${esc(q.question)}<div class="small muted">${dt(q.askedOn)} · <span style="color:${q.status === 'unanswered' ? 'var(--st-overdue-fg)' : 'inherit'}">${esc(q.status)}</span></div></li>`).join('') || '<li class="muted">None detected.</li>'}</ul></div>
      <div class="card"><h3>Next steps</h3><ol class="steps">${a.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div></div>` : ''}
    <div class="card"><h2>Correspondence</h2>${sel.messages.length ? sel.messages.map((m) => `<div class="msg ${m.from}"><div class="meta"><span><b>${esc(m.author)}</b> ${m.from === 'internal' ? '(our team)' : '(customer)'} — ${esc(m.subject)}</span><span>${dt(m.date)}</span></div><p>${esc(m.body)}</p></div>`).join('') : '<p class="small muted">No correspondence on file.</p>'}</div>
  </div>` : '<div class="card empty">No disputes.</div>'}</div>`;
};

views.reminders = async ({ id }, query) => {
  const status = query.get('status') ?? 'pending_approval';
  const list = await api('/reminders' + (status ? '?status=' + status : ''));
  const all = status ? await api('/reminders') : list;
  const sel = all.find((r) => r.id === id) || list[0];
  const tabs = [['pending_approval', 'Pending approval'], ['approved', 'Approved (not sent)'], ['sent_externally', 'Sent externally'], ['rejected', 'Rejected'], ['', 'All']];
  return `<h1 class="page">Draft reminder review</h1><p class="subtitle">AI-drafted reminders wait here for staff review. InvoiceHarbor validates every amount against recorded data and <b>never sends messages itself</b>.</p>
  <div class="chips">${tabs.map(([k, l]) => `<a class="chip ${status === k ? 'on' : ''}" href="#/reminders?status=${k}">${l}</a>`).join('')}</div>
  <div class="list-pane"><div class="card flush">${list.map((r) => `<div class="list-item ${r.id === sel?.id ? 'on' : ''}" data-href="#/reminders/${r.id}?status=${status}"><div class="row" style="justify-content:space-between"><b>${r.id}</b><span class="badge ${r.status === 'pending_approval' ? 'awaiting_information' : r.status === 'approved' ? 'current' : r.status === 'rejected' ? 'overdue' : 'neutral'}">${r.status.replace(/_/g, ' ')}</span></div><div class="small">${r.invoiceId} · ${esc(r.customerName)}</div><div class="small muted">${esc(r.toneLabel || r.tone)} · ${dtt(r.createdAt)}</div></div>`).join('') || '<div class="empty small">Nothing here. Draft one from the <a href="#/queue">follow-up queue</a>.</div>'}</div>
  ${sel ? reminderEditor(sel) : '<div class="card empty">Select a draft.</div>'}</div>`;
};
function reminderEditor(r) {
  const editable = r.status === 'pending_approval';
  const v = r.validation || { ok: true, issues: [] };
  return `<div class="grid"><div class="card">
    <div class="card-head"><div><h2>${r.id} · <a href="#/invoices/${r.invoiceId}">${r.invoiceId}</a></h2><div class="small muted">To: ${esc(r.to || r.customerName)} · ${esc(r.toneLabel || r.tone)}${r.sensitive ? ' · <b style="color:var(--st-disputed-fg)">sensitive collection message</b>' : ''}</div></div><span class="badge neutral">${esc(r.generatorLabel || r.generator)}</span></div>
    ${r.classificationAtDraft ? `<div class="notice ${r.classificationAtDraft.class === 'disputed' ? 'warn' : ''}"><div>Drafted for a <b>${esc(r.classificationAtDraft.label)}</b> invoice${r.classificationAtDraft.daysOverdue ? `, ${r.classificationAtDraft.daysOverdue} days past due` : ''}, verified balance ${usd(r.classificationAtDraft.balance)}.${r.classificationAtDraft.class === 'disputed' ? ' The draft acknowledges the dispute and only requests the undisputed portion.' : ''}</div></div>` : ''}
    ${v.issues.map((i) => `<div class="notice ${i.severity === 'block' ? 'block' : 'warn'}"><b>${i.severity === 'block' ? 'Blocks approval' : 'Check'}:</b>&nbsp;${esc(i.message)}</div>`).join('')}
    <label class="f" for="r-subj">Subject</label><input type="text" id="r-subj" value="${esc(r.subject)}" ${editable ? '' : 'disabled'} />
    <label class="f" for="r-body">Message</label><textarea id="r-body" ${editable ? '' : 'disabled'}>${esc(r.body)}</textarea>
    <div class="row no-print" style="margin-top:12px;justify-content:space-between">
      <div class="row">${editable ? `<button class="btn" data-act="save" data-id="${r.id}">Save &amp; re-validate</button><button class="btn danger" data-act="reject" data-id="${r.id}">Reject</button>` : ''}${r.status === 'approved' ? `<button class="btn" data-act="copy">Copy to clipboard</button>` : ''}</div>
      <div class="row">${editable ? `<button class="btn primary" data-act="approve" data-id="${r.id}" ${v.ok ? '' : 'disabled'}>Approve draft…</button>` : ''}${r.status === 'approved' ? `<button class="btn teal" data-act="marksent" data-id="${r.id}">Record as sent from my mailbox…</button>` : ''}</div></div>
    ${r.approvedBy ? `<p class="small muted">Approved by ${esc(r.approvedBy)} ${r.approvedAt ? dtt(r.approvedAt) : ''}${r.sentAt ? ` · recorded sent ${dtt(r.sentAt)}` : ''}</p>` : ''}
  </div>
  ${r.facts ? `<div class="card"><h2>Figures the draft may use</h2><p class="small muted" style="margin-top:-6px">Any other dollar amount in the message blocks approval.</p><table><tbody>${r.facts.map((f) => `<tr><td>${esc(f.label)}</td><td class="small muted">${esc(f.source)}</td><td class="r strong">${usd(f.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
}

views.reconciliation = async () => {
  const r = await api('/reconciliation');
  const unconfirmed = r.payments.filter((p) => p.status === 'unconfirmed');
  const unapplied = r.payments.filter((p) => p.unapplied);
  return `<h1 class="page">Payment status reconciliation</h1><p class="subtitle">Only payments verified against bank records reduce balances. Invoices are never marked paid without that confirmation.</p>
  <div class="grid g-3"><div class="card kpi"><div class="label">Verified &amp; applied</div><div class="value">${usd(r.summary.verified)}</div></div><div class="card kpi"><div class="label">Unconfirmed claims</div><div class="value">${usd(r.summary.unconfirmed)}</div><div class="foot">remittance advice only — not counted</div></div><div class="card kpi"><div class="label">Verified, unapplied</div><div class="value">${usd(r.summary.unapplied)}</div><div class="foot">deposits needing a match</div></div></div>
  <div class="grid g-2" style="margin-top:16px">
    <div class="card"><h2>Unconfirmed payment claims</h2>${unconfirmed.map((p) => `<div style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px"><div class="row" style="justify-content:space-between"><b>${p.id} · ${usd(p.amount)}</b><span class="badge requires_review">unconfirmed</span></div><div class="small muted">${p.invoiceId} · ${esc(p.customerName)} · claimed ${dt(p.receivedDate)} · ${esc(p.reference)}</div><p class="small">${esc(p.note || '')}</p><div class="row"><button class="btn sm primary" data-act="verify" data-id="${p.id}">Verify against bank…</button><button class="btn sm" data-act="dismiss" data-id="${p.id}">Dismiss claim</button></div></div>`).join('') || '<p class="small muted">No unconfirmed claims.</p>'}</div>
    <div class="card"><h2>Unapplied deposits</h2>${unapplied.map((p) => { const s = r.suggestions.find((x) => x.paymentId === p.id); return `<div style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px"><div class="row" style="justify-content:space-between"><b>${p.id} · ${usd(p.amount)}</b><span class="badge current">verified funds</span></div><div class="small muted">${dt(p.receivedDate)} · ${esc(p.method)} · ref “${esc(p.reference)}”</div><h3 style="margin-top:10px">Suggested matches</h3>${s.candidates.map((c) => `<div class="row" style="justify-content:space-between;padding:6px 0;border-top:1px dashed var(--line)"><div class="small"><b>${c.invoiceId}</b> · ${esc(c.customerName)} · balance ${usd(c.balance)}<div class="muted">${c.why.join(' · ')}</div></div><button class="btn sm primary" data-act="apply" data-id="${p.id}" data-inv="${c.invoiceId}">Apply…</button></div>`).join('') || '<p class="small muted">No confident match — investigate manually.</p>'}</div>`; }).join('') || '<p class="small muted">No unapplied deposits.</p>'}</div>
  </div>
  <div class="card flush" style="margin-top:16px"><div style="padding:16px 18px 0"><h2>Payment ledger</h2></div><table><thead><tr><th>Payment</th><th>Invoice</th><th>Received</th><th>Method / reference</th><th>Source</th><th>Status</th><th class="r">Amount</th></tr></thead><tbody>
  ${r.payments.map((p) => `<tr><td class="mono">${p.id}</td><td>${p.invoiceId ? `<a href="#/invoices/${p.invoiceId}">${p.invoiceId}</a>` : '<span class="muted">unapplied</span>'}</td><td>${dt(p.receivedDate)}</td><td class="small">${esc(p.method)} · ${esc(p.reference)}</td><td class="small">${p.source.replace(/_/g, ' ')}</td><td><span class="badge ${p.status === 'verified' ? 'current' : p.status === 'unconfirmed' ? 'requires_review' : 'neutral'}">${p.status}</span></td><td class="r">${usd(p.amount)}</td></tr>`).join('')}</tbody></table></div>`;
};

let lastExtraction = null;
views.extraction = async () => {
  const samples = await api('/extraction/samples');
  const x = lastExtraction;
  const fieldRows = x ? Object.entries(x.fields).map(([k, f]) => `<tr><td>${k.replace(/([A-Z])/g, ' $1').toLowerCase()}</td><td class="strong">${f.value == null ? '<span class="muted">not found</span>' : esc(typeof f.value === 'number' ? usd(f.value) : f.value)}</td><td class="small"><span class="conf ${f.confidence < 0.9 ? 'low' : ''}"><span style="width:${f.confidence * 100}%"></span></span>${Math.round(f.confidence * 100)}%</td></tr>`).join('') : '';
  return `<h1 class="page">Invoice data extraction</h1><p class="subtitle">Documents are stored in S3 and read with Amazon Textract AnalyzeExpense. Extracted data is checked arithmetically and held for human confirmation — it never becomes a record automatically.</p>
  <div class="grid g-2"><div class="card"><h2>Inbound document</h2><label class="f" for="x-sample">Sample document</label><select id="x-sample">${samples.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select>
    <div style="margin-top:12px"><pre class="doc" id="x-preview">${esc(samples[0].text)}</pre></div><div class="small muted" style="margin:8px 0" id="x-key">s3://invoiceharbor-docs-&lt;tenant&gt;/${esc(samples[0].s3Key)}</div>
    <button class="btn primary" data-act="extract">Run extraction</button></div>
  <div class="card">${x ? `<div class="card-head"><h2>${x.id} · ${esc(x.source)}</h2><span class="badge ${x.status === 'confirmed' ? 'current' : 'awaiting_information'}">${x.status.replace(/_/g, ' ')}</span></div><p class="small muted" style="margin-top:-6px">Engine: ${esc(x.engine)}</p>
    ${x.check.issues.map((i) => `<div class="notice ${i.severity === 'block' ? 'block' : i.severity === 'warn' ? 'warn' : ''}" style="margin-bottom:8px"><b>${i.severity}</b>&nbsp;${esc(i.message)}</div>`).join('')}
    <table><tbody>${fieldRows}</tbody></table>
    <h3 style="margin-top:14px">Line items</h3><table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr></thead><tbody>${x.lineItems.map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${l.quantity ?? `<span class="tag warn">${esc(l.rawQuantity)}?</span>`}</td><td class="r">${usd(l.unitPrice)}</td><td class="r">${usd(l.amount)}</td></tr>`).join('')}</tbody></table>
    ${x.status === 'pending_review' ? `<div class="row" style="margin-top:14px;justify-content:flex-end">${x.check.issues.some((i) => i.severity === 'block') ? `<button class="btn" data-act="confirmx" data-id="${x.id}" data-override="1">Create record &amp; route to review…</button>` : `<button class="btn primary" data-act="confirmx" data-id="${x.id}">Confirm &amp; create invoice…</button>`}</div>` : x.invoiceId ? `<p><a href="#/invoices/${x.invoiceId}">Open ${x.invoiceId} →</a></p>` : ''}` : '<div class="empty">Choose a document and run extraction to see fields, confidence, and arithmetic checks.</div>'}</div></div>`;
};

views.reports = async () => {
  const r = await api('/reports');
  const maxSeg = Math.max(...r.bySegment.map((s) => s.outstanding), 1);
  return `<div class="row" style="justify-content:space-between"><div><h1 class="page">Receivables reporting</h1><p class="subtitle">As of ${dt(r.asOf)}. ${esc(r.narrativeSource)}</p></div><button class="btn no-print" onclick="window.print()">Print / PDF</button></div>
  <div class="card" style="margin-bottom:16px"><h2>Executive summary</h2>${r.narrative.map((n) => `<p style="margin:0 0 6px">${esc(n)}</p>`).join('')}</div>
  <div class="grid g-2">
    <div class="card"><h2>Aging</h2>${agingBar(r.aging)}</div>
    <div class="card"><h2>Outstanding by segment</h2>${r.bySegment.map((s) => `<div class="hbar"><span>${esc(s.segment)}</span><div class="track"><div class="fill" style="width:${(s.outstanding / maxSeg) * 100}%" data-tip="${s.segment}: ${usd(s.outstanding)} outstanding, ${usd(s.overdue)} past due"></div></div><span class="r num small">${usd0(s.outstanding)}</span></div>`).join('')}</div>
    <div class="card flush"><div style="padding:16px 18px 0"><h2>Dispute patterns</h2></div><table><thead><tr><th>Category</th><th class="r">Open</th><th class="r">Resolved</th><th class="r">Open amount</th></tr></thead><tbody>${r.disputesByCategory.map((d) => `<tr><td style="text-transform:capitalize">${esc(d.category)}</td><td class="r">${d.open}</td><td class="r">${d.resolved}</td><td class="r">${usd(d.openAmount)}</td></tr>`).join('')}</tbody></table></div>
    <div class="card"><h2>Follow-up activity</h2><p class="small muted" style="margin-top:-6px">${esc(r.activity.window)}</p><dl class="kv"><dt>Reminders drafted</dt><dd>${r.activity.remindersDrafted}</dd><dt>Reminders approved</dt><dd>${r.activity.remindersApproved}</dd><dt>Recorded as sent (by staff)</dt><dd>${r.activity.remindersSentExternally}</dd><dt>Payments verified</dt><dd>${r.activity.paymentsVerified}</dd><dt>Deposits applied</dt><dd>${r.activity.paymentsApplied}</dd><dt>Dispute analyses</dt><dd>${r.activity.disputesUpdated}</dd></dl></div>
    <div class="card flush"><div style="padding:16px 18px 0"><h2>Largest past-due customers</h2></div><table><tbody>${r.topOverdue.map((c) => `<tr class="click" data-href="#/customers/${c.id}"><td>${esc(c.name)}</td><td class="r strong">${usd(c.overdue)}</td></tr>`).join('')}</tbody></table></div>
    <div class="card flush"><div style="padding:16px 18px 0"><h2>By classification</h2></div><table><tbody>${r.byClass.map((b) => `<tr><td>${badge(b)}</td><td class="r">${b.count}</td><td class="r">${usd(b.amount)}</td></tr>`).join('')}</tbody></table></div>
  </div>`;
};

views.activity = async () => {
  const a = await api('/activity');
  return `<h1 class="page">Activity history</h1><p class="subtitle">Immutable audit trail of classifications, drafts, approvals, verifications, and staff actions.</p>
  <div class="card flush"><table><thead><tr><th>When</th><th>Actor</th><th>Event</th><th>Invoice</th><th>Detail</th></tr></thead><tbody>${a.map((e) => `<tr><td class="small num">${dtt(e.at)}</td><td>${esc(e.actor)}</td><td><span class="tag">${e.type.replace(/_/g, ' ')}</span></td><td>${e.invoiceId ? `<a href="#/invoices/${e.invoiceId}">${e.invoiceId}</a>` : '—'}</td><td class="small">${esc(e.message)}</td></tr>`).join('')}</tbody></table></div>`;
};

views.settings = async () => {
  const s = await api('/settings');
  const labels = { overdue: 'Overdue duration (max points)', balance: 'Balance size (max points)', dispute: 'Open dispute', brokenPromise: 'Broken promise to pay', awaitingInfo: 'Information outstanding', keyAccount: 'Key account rule', recentContactPenalty: 'Recent-contact cooldown (deduction)' };
  return `<h1 class="page">Rules &amp; safeguards</h1><p class="subtitle">Prioritization is driven by business rules you control. Financial safeguards are fixed.</p>
  <div class="grid g-2"><div class="card"><h2>Prioritization weights</h2>${Object.entries(s.weights).map(([k, v]) => `<label class="f" for="w-${k}">${labels[k]}: <b id="wv-${k}">${v}</b></label><input type="range" min="0" max="60" value="${v}" id="w-${k}" data-w="${k}" style="width:100%" />`).join('')}
    <label class="f" for="s-cool">Reminder cooldown (days)</label><input type="number" id="s-cool" value="${s.reminderCooldownDays}" />
    <label class="f" for="s-esc">Escalated tone after (days overdue)</label><input type="number" id="s-esc" value="${s.escalationDays}" />
    <label class="check"><input type="checkbox" id="s-undisp" ${s.requestUndisputedPortion ? 'checked' : ''} /> <span>When a dispute is open, reminders may request the undisputed portion</span></label>
    <button class="btn primary" data-act="savesettings" style="margin-top:8px">Save rules</button></div>
  <div class="card"><h2>Locked financial safeguards</h2><ul class="clean">
    <li>🔒 <b>Recorded data is authoritative.</b> Balances = invoice totals − verified payments. Models never produce balances.</li>
    <li>🔒 <b>No automatic paid status.</b> Invoices become paid only when verified payments cover the total. (<code>autoMarkPaid: ${s.autoMarkPaid}</code>)</li>
    <li>🔒 <b>No payment initiation.</b> InvoiceHarbor has no capability to move money.</li>
    <li>🔒 <b>No automatic sending.</b> Drafts require named approval; sensitive messages need explicit acknowledgement; staff send from their own mailbox. (<code>autoSendReminders: ${s.autoSendReminders}</code>)</li>
    <li>🔒 <b>Amount validation.</b> Any dollar figure in a draft that isn't a recorded figure blocks approval.</li>
    <li>🔒 <b>Estimates are labelled.</b> Payment-timing estimates are always shown separately from verified payment information.</li>
    <li>🔒 <b>Data separation.</b> Marketing/CRM data (HubSpot) is stored separately from financial records.</li></ul></div></div>`;
};

// ---------- Guided demo ----------
let demoStep = 0; let demoDraft = null;
views.demo = async () => {
  const id = 'INV-2026-1007';
  const [inv, disputes] = await Promise.all([api('/invoices/' + id), api('/disputes')]);
  const d = disputes.find((x) => x.invoiceId === id);
  const a = d.analysis || await api(`/disputes/${d.id}/analyze`, { method: 'POST', body: { actor: 'System' } });
  const c = inv.classification;
  const steps = ['Identify', 'Understand the dispute', 'Prioritize', 'Draft for review'];
  const body = [
    () => `<div class="grid g-2"><div class="card"><h2>1 · The system classifies ${id}</h2><p>${badge(c)} ${flagTags(c)}</p><ul class="clean">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul><p class="small muted">Rule order: data-review issues → open dispute → information requests → overdue → current. A dispute takes precedence over plain "overdue" so the invoice routes to resolution, not routine collections.</p></div>
      <div class="card"><h2>Recorded figures (authoritative)</h2><dl class="kv"><dt>Customer</dt><dd>${esc(inv.customerName)}</dd><dt>Recorded total</dt><dd>${usd(c.total)}</dd><dt>Verified payments</dt><dd>${usd(c.verifiedPaid)}</dd><dt>Verified balance</dt><dd class="total">${usd(c.balance)}</dd><dt>Due date</dt><dd>${dt(inv.dueDate)}</dd><dt>Days past due</dt><dd>${c.daysOverdue}</dd><dt>Disputed (record)</dt><dd>${usd(inv.dispute.disputedAmount)}</dd></dl><div style="margin-top:12px">${timingBox(inv.paymentTiming)}</div></div></div>`,
    () => `<div class="grid g-2"><div class="card"><h2>2 · Dispute intelligence</h2><p>${esc(a.summary)}</p><ul class="clean">${a.signals.map((s) => `<li>• ${esc(s)}</li>`).join('')}</ul><p class="small muted">${esc(a.generatorLabel)}</p></div>
      <div class="grid"><div class="card"><h3>Missing information</h3><ul class="clean">${a.missingInformation.map((m) => `<li>☐ ${esc(m.label)}</li>`).join('')}</ul></div><div class="card"><h3>Unresolved questions</h3><ul class="clean">${a.unresolvedQuestions.map((q) => `<li>${esc(q.question)} <span class="small muted">(${esc(q.status)})</span></li>`).join('')}</ul></div><div class="card"><h3>Next steps</h3><ol class="steps">${a.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div></div></div>`,
    () => `<div class="grid g-2"><div class="card"><div class="card-head"><h2>3 · Transparent priority</h2><span class="score">${inv.priority.score.toFixed(1)}</span></div>${factorList(inv.priority)}<p class="small">Recommended action: <b>${esc(inv.priority.recommendedAction.label)}</b></p></div>
      <div class="card"><h2>Why not a standard overdue reminder?</h2><ul class="clean"><li>The customer is holding the full invoice over a ${usd(inv.dispute.disputedAmount)} quantity question.</li><li>Demanding the full ${usd(c.balance)} would ignore their open questions and damage the relationship.</li><li>Rule <i>"request undisputed portion"</i> is on, so the reminder asks for ${usd(c.balance - inv.dispute.disputedAmount)} and commits to resolving the remainder.</li><li>Because it is a dispute-aware collection message, it is flagged <b>sensitive</b> and requires explicit acknowledgement to approve.</li></ul></div></div>`,
    () => demoDraft ? `<div class="notice"><div><b>Draft ${demoDraft.id} created and waiting for approval.</b> Nothing has been sent. <a href="#/reminders/${demoDraft.id}">Open it in Draft reminder review →</a></div></div><div class="list-pane" style="grid-template-columns:1fr"><div>${reminderEditor(demoDraft)}</div></div>`
      : `<div class="card"><h2>4 · Prepare a reminder for staff review</h2><p>InvoiceHarbor drafts a dispute-aware message using only recorded figures, validates every amount, and places it in the review queue. It will not be sent.</p><button class="btn primary" data-act="demodraft">Generate draft for ${id}</button></div>`,
  ];
  return `<h1 class="page">Guided demo: a disputed, overdue invoice</h1><p class="subtitle">Follow ${id} from classification to a reviewable reminder — with every safeguard visible.</p>
  <div class="demo-steps">${steps.map((s, i) => `<button class="demo-step ${i === demoStep ? 'on' : ''} ${i < demoStep ? 'done' : ''}" data-step="${i}"><div class="n">Step ${i + 1}${i < demoStep ? ' ✓' : ''}</div><div class="strong">${s}</div></button>`).join('')}</div>
  ${body[demoStep]()}
  <div class="row" style="justify-content:space-between;margin-top:16px"><button class="btn" data-step="${Math.max(0, demoStep - 1)}" ${demoStep === 0 ? 'disabled' : ''}>← Back</button>${demoStep < 3 ? `<button class="btn primary" data-step="${demoStep + 1}">Next: ${steps[demoStep + 1]} →</button>` : ''}</div>`;
};

// ---------- Router ----------
async function render() {
  const [path, qs] = (location.hash.slice(2) || 'overview').split('?');
  const [section, id] = path.split('/');
  const query = new URLSearchParams(qs || '');
  const viewName = section === 'invoices' && id ? 'invoice' : section === 'customers' && id ? 'customer' : section;
  renderNav(section);
  const fn = views[viewName] || views.overview;
  try {
    view.innerHTML = await fn({ id: id && decodeURIComponent(id) }, query);
    if (viewName === 'extraction') wireExtraction();
    if (viewName === 'settings') view.querySelectorAll('[data-w]').forEach((el) => el.oninput = () => { $('#wv-' + el.dataset.w).textContent = el.value; });
  } catch (e) {
    view.innerHTML = `<div class="card empty">Could not load this view: ${esc(e.message)}</div>`;
  }
  refreshCounts().then(() => renderNav(section)).catch(() => {});
}
function wireExtraction() {
  api('/extraction/samples').then((samples) => {
    const sel = $('#x-sample');
    if (!sel) return;
    if (lastExtraction) { const m = samples.find((s) => lastExtraction.source === s.label); if (m) { sel.value = m.id; $('#x-preview').textContent = m.text; } }
    sel.onchange = () => { const s = samples.find((x) => x.id === sel.value); $('#x-preview').textContent = s.text; $('#x-key').textContent = `s3://invoiceharbor-docs-<tenant>/${s.s3Key}`; };
  });
}

// ---------- Actions ----------
view.addEventListener('click', async (e) => {
  const rowLink = e.target.closest('[data-href]');
  if (rowLink && !e.target.closest('a,button')) { location.hash = rowLink.dataset.href; return; }
  const stepBtn = e.target.closest('[data-step]');
  if (stepBtn) { demoStep = Number(stepBtn.dataset.step); return render(); }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  try {
    if (act === 'draft') {
      b.disabled = true;
      const r = await api('/reminders', { method: 'POST', body: { invoiceId: id, actor: reviewer } });
      toast(`Draft ${r.id} created — awaiting your review. Nothing was sent.`);
      location.hash = `#/reminders/${r.id}?status=pending_approval`;
    } else if (act === 'demodraft') {
      demoDraft = await api('/reminders', { method: 'POST', body: { invoiceId: 'INV-2026-1007', actor: reviewer } });
      render();
    } else if (act === 'markpaid') {
      await api(`/invoices/${id}/mark-paid`, { method: 'POST' });
    } else if (act === 'analyze') {
      await api(`/disputes/${id}/analyze`, { method: 'POST', body: { actor: reviewer } });
      toast('Dispute analysis refreshed.'); render();
    } else if (act === 'save') {
      await api('/reminders/' + id, { method: 'PATCH', body: { subject: $('#r-subj').value, body: $('#r-body').value, actor: reviewer } });
      toast('Saved and re-validated.'); render();
    } else if (act === 'reject') {
      await api(`/reminders/${id}/reject`, { method: 'POST', body: { reviewer } });
      toast('Draft rejected.'); render();
    } else if (act === 'approve') {
      await api('/reminders/' + id, { method: 'PATCH', body: { subject: $('#r-subj').value, body: $('#r-body').value, actor: reviewer } });
      const list = await api('/reminders');
      const r = list.find((x) => x.id === id);
      if (!r.validation.ok) { toast('Draft failed validation after your edits — fix the highlighted issues.', true); return render(); }
      const checks = ['I have read this message and confirm the figures match our records.'];
      if (r.sensitive) checks.push('I understand this is a <b>sensitive collection message</b> and I am authorized to approve it.');
      const ok = await confirmModal({ title: `Approve ${id}?`, body: 'Approval records your name in the audit trail. <b>InvoiceHarbor will not send this message</b> — you send it from your own mailbox, then record it as sent.', confirmLabel: 'Approve draft', checks });
      if (!ok) return;
      await api(`/reminders/${id}/approve`, { method: 'POST', body: { reviewer: ok.reviewer, confirm: true, acknowledgeSensitive: r.sensitive } });
      toast('Approved. Not sent — copy it into your mailbox when ready.'); demoDraft = null;
      location.hash = `#/reminders/${id}?status=approved`;
    } else if (act === 'copy') {
      await navigator.clipboard.writeText(`Subject: ${$('#r-subj').value}\n\n${$('#r-body').value}`);
      toast('Copied to clipboard.');
    } else if (act === 'marksent') {
      const ok = await confirmModal({ title: 'Record as sent?', body: 'Confirm you have sent this approved message yourself from an authorized mailbox. This only updates the activity record.', confirmLabel: 'Record as sent', checks: ['I sent this message myself.'] });
      if (!ok) return;
      await api(`/reminders/${id}/mark-sent`, { method: 'POST', body: { reviewer: ok.reviewer, confirm: true } });
      toast('Recorded as sent.'); render();
    } else if (act === 'verify') {
      const ok = await confirmModal({ title: `Verify payment ${id}?`, body: 'Only verify once the funds appear in your bank records. Verification reduces the invoice balance and may move it to Paid.', confirmLabel: 'Verify payment', fields: [{ key: 'bank', label: 'Bank transaction reference', placeholder: 'e.g. ACH trace 0210-88412' }], checks: ['I confirmed these funds in our bank records.'] });
      if (!ok) return;
      const r = await api(`/payments/${id}/verify`, { method: 'POST', body: { reviewer: ok.reviewer, confirm: true, bankReference: ok.values.bank } });
      toast(`Verified. ${r.invoice ? r.invoice.number + ' is now ' + r.invoice.classification.label + '.' : ''}`); render();
    } else if (act === 'dismiss') {
      await api(`/payments/${id}/dismiss`, { method: 'POST', body: { reviewer, reason: 'Not received in bank' } });
      toast('Claim dismissed; invoice returns to its underlying status.'); render();
    } else if (act === 'apply') {
      const ok = await confirmModal({ title: `Apply ${id} to ${b.dataset.inv}?`, body: 'This links verified bank funds to the invoice and reduces its balance.', confirmLabel: 'Apply payment', checks: ['I reviewed the match evidence.'] });
      if (!ok) return;
      const r = await api(`/payments/${id}/apply`, { method: 'POST', body: { reviewer: ok.reviewer, confirm: true, invoiceId: b.dataset.inv } });
      toast(`Applied. ${r.invoice.number} is now ${r.invoice.classification.label}.`); render();
    } else if (act === 'extract') {
      lastExtraction = await api('/extraction', { method: 'POST', body: { sampleId: $('#x-sample').value, actor: reviewer } });
      render();
    } else if (act === 'confirmx') {
      const override = b.dataset.override === '1';
      const ok = await confirmModal({ title: override ? 'Create record and route to review?' : 'Create invoice record?', body: override ? 'Blocking issues were found. The invoice will be created with review flags and will be excluded from reminders until resolved.' : 'Creates an invoice record from the confirmed fields.', confirmLabel: 'Create record', checks: ['I compared the extracted fields with the source document.'] });
      if (!ok) return;
      const inv = await api(`/extraction/${id}/confirm`, { method: 'POST', body: { reviewer: ok.reviewer, confirm: true, overrideBlocking: override } });
      lastExtraction = { ...lastExtraction, status: 'confirmed', invoiceId: inv.id };
      toast(`${inv.number} created — ${inv.classification.label}.`); render();
    } else if (act === 'savesettings') {
      const weights = Object.fromEntries([...view.querySelectorAll('[data-w]')].map((el) => [el.dataset.w, Number(el.value)]));
      await api('/settings', { method: 'PUT', body: { weights, reminderCooldownDays: Number($('#s-cool').value), escalationDays: Number($('#s-esc').value), requestUndisputedPortion: $('#s-undisp').checked, actor: reviewer } });
      toast('Rules saved. Queue re-ranked.');
    }
  } catch (err) {
    toast(err.message, true);
    b.disabled = false;
  }
});

$('#globalSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = '#/invoices?q=' + encodeURIComponent(e.target.value); });
$('#reset').onclick = async (e) => { e.preventDefault(); await api('/demo/reset', { method: 'POST' }); demoDraft = null; lastExtraction = null; demoStep = 0; toast('Demo data reset.'); render(); };
addEventListener('hashchange', render);
render();
