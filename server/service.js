// Application service layer. In production these operations run against PostgreSQL
// (see db/schema.sql); the demo keeps the same shapes in memory.

import { buildSeed, customers as seedCustomers, sampleDocuments, DEMO_AS_OF } from './data/seed.js';
import { classify, prioritize, estimatePaymentTiming, agingBucket, BUCKETS, round2, fmtUSD, daysBetween, addDays, CLASS_LABELS } from './engine/core.js';
import { analyzeDispute } from './engine/disputes.js';
import { draftReminder, validateDraft, allowedFacts, chooseTone, TONE_LABELS } from './engine/reminders.js';
import { parseInvoiceText, checkExtraction } from './engine/extraction.js';
import { MODE, textractAnalyzeExpense } from './aws/adapters.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const SENDER = { name: 'Jordan Whitfield', title: 'Senior Specialist', company: 'Harbor Packaging & Services (demo tenant)' };
let db;
let marketing; // Separate store: marketing / prospect data never mixes with financial records.

export function reset() {
  db = { ...buildSeed(), customers: structuredClone(seedCustomers) };
  marketing = { demoRequests: [] };
}
reset();

export const asOf = () => DEMO_AS_OF;
const now = () => new Date().toISOString();
const log = (actor, type, invoiceId, message) => db.activity.push({ at: now(), actor, type, invoiceId, message });
const requireConfirm = (body, what) => {
  if (body?.confirm !== true) throw new HttpError(400, `Explicit confirmation required to ${what}.`);
  if (!body?.reviewer || !String(body.reviewer).trim()) throw new HttpError(400, 'Reviewer name is required for the audit trail.');
};

const customerOf = (inv) => db.customers.find((c) => c.id === inv.customerId);
const getInvoice = (id) => {
  const inv = db.invoices.find((i) => i.id === id);
  if (!inv) throw new HttpError(404, `Invoice ${id} not found.`);
  return inv;
};

function enrich(inv) {
  const c = classify(inv, db, asOf());
  const cust = customerOf(inv);
  return {
    ...inv, customerName: cust.name, segment: cust.segment, classification: c,
    agingBucket: c.class === 'paid' ? null : agingBucket(c.daysOverdue),
    priority: prioritize(inv, c, db, asOf()),
    paymentTiming: estimatePaymentTiming(inv, c, db, asOf()),
  };
}
const all = () => db.invoices.map(enrich);

// ---------- Invoices & customers ----------
export function listInvoices({ cls, customer, q } = {}) {
  return all()
    .filter((i) => !cls || i.classification.class === cls || i.classification.flags.includes(cls))
    .filter((i) => !customer || i.customerId === customer)
    .filter((i) => !q || `${i.number} ${i.customerName} ${i.poNumber}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}

export function invoiceDetail(id) {
  const inv = enrich(getInvoice(id));
  return {
    ...inv,
    payments: db.payments.filter((p) => p.invoiceId === id),
    dispute: db.disputes.find((d) => d.invoiceId === id && d.status === 'open') || null,
    pastDisputes: db.disputes.filter((d) => d.invoiceId === id && d.status !== 'open'),
    infoRequests: db.infoRequests.filter((r) => r.invoiceId === id),
    promises: db.promises.filter((p) => p.invoiceId === id),
    reminders: db.reminders.filter((r) => r.invoiceId === id),
    activity: db.activity.filter((a) => a.invoiceId === id).sort((a, b) => b.at.localeCompare(a.at)),
  };
}

export function markPaidAttempt(id) {
  const inv = enrich(getInvoice(id));
  throw new HttpError(409, inv.classification.class === 'paid'
    ? 'Invoice is already paid per verified payment records.'
    : `Invoices cannot be marked paid manually. Paid status is derived only from verified payments; current verified balance is ${fmtUSD(inv.classification.balance)}. Record and verify a payment in Reconciliation instead.`);
}

export function listCustomers() {
  const invs = all();
  return db.customers.map((c) => {
    const mine = invs.filter((i) => i.customerId === c.id);
    const open = mine.filter((i) => i.classification.class !== 'paid');
    return {
      ...c,
      openInvoices: open.length,
      outstanding: round2(open.reduce((s, i) => s + Math.max(0, i.classification.balance), 0)),
      overdue: round2(open.filter((i) => i.classification.daysOverdue > 0).reduce((s, i) => s + i.classification.balance, 0)),
      unconfirmed: round2(mine.reduce((s, i) => s + i.classification.unconfirmedClaimed, 0)),
      openDisputes: db.disputes.filter((d) => d.customerId === c.id && d.status === 'open').length,
      utilization: c.creditLimit ? round2(open.reduce((s, i) => s + i.classification.balance, 0) / c.creditLimit) : null,
    };
  });
}
export function customerDetail(id) {
  const c = listCustomers().find((x) => x.id === id);
  if (!c) throw new HttpError(404, 'Customer not found');
  return { ...c, invoices: listInvoices({ customer: id }), disputes: db.disputes.filter((d) => d.customerId === id), activity: db.activity.filter((a) => a.invoiceId && getInvoice(a.invoiceId).customerId === id).sort((a, b) => b.at.localeCompare(a.at)) };
}

// ---------- Aging, overview, reports ----------
export function aging() {
  const invs = all().filter((i) => i.classification.class !== 'paid' && i.classification.balance > 0);
  const rows = db.customers.map((c) => {
    const row = { customerId: c.id, customerName: c.name, buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])), total: 0 };
    for (const i of invs.filter((x) => x.customerId === c.id)) { row.buckets[i.agingBucket] = round2(row.buckets[i.agingBucket] + i.classification.balance); row.total = round2(row.total + i.classification.balance); }
    return row;
  }).filter((r) => r.total > 0);
  const totals = Object.fromEntries(BUCKETS.map((b) => [b, round2(rows.reduce((s, r) => s + r.buckets[b], 0))]));
  return { asOf: asOf(), buckets: BUCKETS, rows, totals, grandTotal: round2(rows.reduce((s, r) => s + r.total, 0)), basis: 'Balances = recorded invoice totals − verified payments. Unconfirmed remittances are excluded.' };
}

export function overview() {
  const invs = all();
  const open = invs.filter((i) => i.classification.class !== 'paid');
  const sum = (arr) => round2(arr.reduce((s, i) => s + i.classification.balance, 0));
  const byClass = Object.keys(CLASS_LABELS).map((k) => ({ class: k, label: CLASS_LABELS[k], count: invs.filter((i) => i.classification.class === k).length, amount: sum(invs.filter((i) => i.classification.class === k)) }));
  const ag = aging();
  const pendingDrafts = db.reminders.filter((r) => r.status === 'pending_approval').length;
  const unconfirmed = round2(db.payments.filter((p) => p.status === 'unconfirmed').reduce((s, p) => s + p.amount, 0));
  const unapplied = round2(db.payments.filter((p) => p.unapplied).reduce((s, p) => s + p.amount, 0));
  const overdueOpen = open.filter((i) => i.classification.daysOverdue > 0);
  const weightedDays = sum(overdueOpen) ? Math.round(overdueOpen.reduce((s, i) => s + i.classification.daysOverdue * i.classification.balance, 0) / sum(overdueOpen)) : 0;
  return {
    asOf: asOf(), mode: MODE,
    kpis: {
      outstanding: sum(open), overdue: sum(overdueOpen), overduePct: sum(open) ? round2((sum(overdueOpen) / sum(open)) * 100) : 0,
      disputed: round2(db.disputes.filter((d) => d.status === 'open').reduce((s, d) => s + d.disputedAmount, 0)),
      openInvoices: open.length, weightedDaysOverdue: weightedDays, pendingDrafts, unconfirmed, unapplied,
    },
    byClass, aging: ag.totals,
    topQueue: followUpQueue().slice(0, 5),
    recentActivity: [...db.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8),
  };
}

export function reports() {
  const o = overview();
  const invs = all();
  const disputes = db.disputes.map((d) => ({ ...d, customerName: db.customers.find((c) => c.id === d.customerId).name }));
  const byCategory = {};
  for (const d of disputes) {
    const k = d.category.replace(/_/g, ' ');
    byCategory[k] ||= { category: k, open: 0, resolved: 0, openAmount: 0 };
    if (d.status === 'open') { byCategory[k].open++; byCategory[k].openAmount = round2(byCategory[k].openAmount + d.disputedAmount); } else byCategory[k].resolved++;
  }
  const since = addDays(asOf(), -30);
  const recent = db.activity.filter((a) => a.at.slice(0, 10) >= since);
  const count = (t) => recent.filter((a) => a.type === t).length;
  const activity = {
    window: `${since} to ${asOf()} (plus this session)`,
    remindersDrafted: count('reminder_drafted'), remindersApproved: count('reminder_approved'),
    remindersSentExternally: count('reminder_sent_externally'), paymentsVerified: count('payment_verified'),
    paymentsApplied: count('payment_applied'), disputesUpdated: count('dispute_analyzed'),
  };
  const bySegment = {};
  for (const i of invs.filter((x) => x.classification.class !== 'paid')) {
    bySegment[i.segment] ||= { segment: i.segment, outstanding: 0, overdue: 0 };
    bySegment[i.segment].outstanding = round2(bySegment[i.segment].outstanding + i.classification.balance);
    if (i.classification.daysOverdue > 0) bySegment[i.segment].overdue = round2(bySegment[i.segment].overdue + i.classification.balance);
  }
  const topOverdue = listCustomers().filter((c) => c.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 5);
  const k = o.kpis;
  const narrative = [
    `As of ${asOf()}, verified outstanding receivables total ${fmtUSD(k.outstanding)} across ${k.openInvoices} open invoices.`,
    `${fmtUSD(k.overdue)} (${k.overduePct}%) is past due, with a balance-weighted average of ${k.weightedDaysOverdue} days overdue.`,
    `${fmtUSD(o.aging['90+'])} sits in the 90+ bucket.`,
    `Open disputes cover ${fmtUSD(k.disputed)}; the largest category is ${Object.values(byCategory).filter((c) => c.open).sort((a, b) => b.openAmount - a.openAmount)[0]?.category || 'n/a'}.`,
    k.unconfirmed ? `${fmtUSD(k.unconfirmed)} in customer-reported payments is awaiting bank confirmation and is not counted as received.` : '',
    k.unapplied ? `${fmtUSD(k.unapplied)} in verified deposits is unapplied and needs matching.` : '',
  ].filter(Boolean);
  return { asOf: asOf(), kpis: k, byClass: o.byClass, aging: o.aging, disputesByCategory: Object.values(byCategory), activity, bySegment: Object.values(bySegment), topOverdue, narrative, narrativeSource: 'Generated from verified records by the reporting engine; every figure is computed, not model-generated.' };
}

// ---------- Follow-up queue ----------
export function followUpQueue() {
  return all().filter((i) => i.priority).sort((a, b) => b.priority.score - a.priority.score).map((i, idx) => ({
    rank: idx + 1, invoiceId: i.id, number: i.number, customerName: i.customerName, classification: i.classification,
    priority: i.priority, suggestedTone: TONE_LABELS[chooseTone(i.classification, db.settings)],
    hasPendingDraft: db.reminders.some((r) => r.invoiceId === i.id && r.status === 'pending_approval'),
  }));
}

// ---------- Disputes ----------
export function listDisputes() {
  return db.disputes.map((d) => {
    const inv = enrich(getInvoice(d.invoiceId));
    return { ...d, invoiceNumber: inv.number, customerName: inv.customerName, balance: inv.classification.balance, daysOverdue: inv.classification.daysOverdue, daysOpen: daysBetween(d.openedDate, d.resolvedDate || asOf()), lastMessage: d.messages.at(-1) || null, analysis: d.analysis || null };
  }).sort((a, b) => (a.status === 'open' ? -1 : 1) - (b.status === 'open' ? -1 : 1));
}
export async function runDisputeAnalysis(id, actor = 'System') {
  const d = db.disputes.find((x) => x.id === id);
  if (!d) throw new HttpError(404, 'Dispute not found');
  const inv = enrich(getInvoice(d.invoiceId));
  d.analysis = { ...(await analyzeDispute(d, inv, inv.classification.balance, asOf())), generatedAt: now() };
  log(actor, 'dispute_analyzed', d.invoiceId, `Dispute ${d.id} summarised (${d.analysis.generatorLabel}).`);
  return d.analysis;
}

// ---------- Reminders ----------
export async function createDraft({ invoiceId, tone, actor = 'J. Whitfield' }) {
  const raw = getInvoice(invoiceId);
  const inv = enrich(raw);
  const c = inv.classification;
  if (c.class === 'paid') throw new HttpError(409, 'Invoice is paid per verified records — no reminder needed.');
  if (c.class === 'requires_review') throw new HttpError(409, `Record requires review before any customer contact: ${c.reasons[0]}`);
  const ctx = { invoice: inv, customer: customerOf(raw), c, dispute: db.disputes.find((d) => d.invoiceId === invoiceId && d.status === 'open'), infoRequest: db.infoRequests.find((r) => r.invoiceId === invoiceId && r.status === 'open'), settings: db.settings, sender: SENDER };
  const d = await draftReminder(ctx, tone);
  const rec = {
    id: `RMD-${db.counters.reminder++}`, invoiceId, createdAt: now(), createdBy: actor, status: 'pending_approval',
    to: `${ctx.customer.contact.name} <${ctx.customer.contact.email}>`, ...d,
    classificationAtDraft: { class: c.class, label: c.label, daysOverdue: c.daysOverdue, balance: c.balance },
  };
  db.reminders.push(rec);
  log(actor, 'reminder_drafted', invoiceId, `Draft ${rec.id} (${rec.toneLabel}) created for staff review.${rec.validation.ok ? '' : ' Validation issues must be fixed before approval.'}`);
  return rec;
}
export function listReminders(status) {
  return db.reminders.filter((r) => !status || r.status === status).map((r) => ({ ...r, invoiceNumber: r.invoiceId, customerName: customerOf(getInvoice(r.invoiceId)).name })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
const getReminder = (id) => {
  const r = db.reminders.find((x) => x.id === id);
  if (!r) throw new HttpError(404, 'Reminder not found');
  return r;
};
function revalidate(r) {
  const raw = getInvoice(r.invoiceId);
  const inv = enrich(raw);
  const ctx = { invoice: inv, customer: customerOf(raw), c: inv.classification, dispute: db.disputes.find((d) => d.invoiceId === r.invoiceId && d.status === 'open') };
  r.facts = allowedFacts(ctx);
  r.validation = validateDraft(r.body, r.facts, ctx);
  if (/\[Staff:/.test(r.body)) r.validation = { ok: false, issues: [...r.validation.issues, { severity: 'block', message: 'Placeholder text "[Staff: …]" must be replaced before approval.' }] };
}
export function editReminder(id, { subject, body, actor = 'J. Whitfield' }) {
  const r = getReminder(id);
  if (r.status !== 'pending_approval') throw new HttpError(409, 'Only drafts pending approval can be edited.');
  if (subject != null) r.subject = subject;
  if (body != null) r.body = body;
  r.editedAt = now(); r.editedBy = actor;
  revalidate(r);
  log(actor, 'reminder_edited', r.invoiceId, `Draft ${r.id} edited by staff.`);
  return r;
}
export function approveReminder(id, body) {
  requireConfirm(body, 'approve this reminder');
  const r = getReminder(id);
  if (r.status !== 'pending_approval') throw new HttpError(409, `Draft is ${r.status}.`);
  revalidate(r);
  if (!r.validation.ok) throw new HttpError(422, 'Draft failed validation: ' + r.validation.issues.filter((i) => i.severity === 'block').map((i) => i.message).join(' '));
  if (r.sensitive && body.acknowledgeSensitive !== true) throw new HttpError(400, 'This is a sensitive collection message (dispute-aware, firm, or escalated). Acknowledge sensitivity to approve.');
  Object.assign(r, { status: 'approved', approvedBy: body.reviewer, approvedAt: now() });
  log(body.reviewer, 'reminder_approved', r.invoiceId, `Draft ${r.id} approved. Not sent — InvoiceHarbor never sends collection messages automatically.`);
  return r;
}
export function rejectReminder(id, { reviewer = 'J. Whitfield', reason = '' } = {}) {
  const r = getReminder(id);
  if (!['pending_approval', 'approved'].includes(r.status)) throw new HttpError(409, `Draft is ${r.status}.`);
  Object.assign(r, { status: 'rejected', rejectedBy: reviewer, rejectedAt: now(), rejectReason: reason });
  log(reviewer, 'reminder_rejected', r.invoiceId, `Draft ${r.id} rejected${reason ? `: ${reason}` : ''}.`);
  return r;
}
export function markReminderSent(id, body) {
  requireConfirm(body, 'record this reminder as sent');
  const r = getReminder(id);
  if (r.status !== 'approved') throw new HttpError(409, 'Only approved drafts can be recorded as sent.');
  Object.assign(r, { status: 'sent_externally', sentAt: now(), sentRecordedBy: body.reviewer });
  log(body.reviewer, 'reminder_sent_externally', r.invoiceId, `Staff recorded draft ${r.id} as sent from their own mailbox.`);
  return r;
}

// ---------- Payments & reconciliation ----------
export function reconciliation() {
  const invs = all();
  const payments = db.payments.map((p) => ({ ...p, invoiceNumber: p.invoiceId, customerName: p.invoiceId ? customerOf(getInvoice(p.invoiceId)).name : null }));
  const suggestions = db.payments.filter((p) => p.unapplied).map((p) => ({
    paymentId: p.id,
    candidates: invs.filter((i) => i.classification.balance > 0).map((i) => {
      let score = 0; const why = [];
      if (Math.abs(i.classification.balance - p.amount) < 0.005) { score += 60; why.push('Amount equals verified balance'); }
      const tokens = p.reference.toUpperCase().split(/\s+/);
      if (i.poNumber && tokens.some((t) => i.poNumber.toUpperCase().endsWith(t) && t.length >= 4)) { score += 25; why.push(`Reference matches PO ${i.poNumber}`); }
      if (tokens.some((t) => t.length > 3 && i.customerName.toUpperCase().includes(t))) { score += 15; why.push('Reference contains customer name'); }
      return { invoiceId: i.id, customerName: i.customerName, balance: i.classification.balance, score, why };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3),
  }));
  return {
    payments, suggestions,
    summary: {
      verified: round2(db.payments.filter((p) => p.status === 'verified' && !p.unapplied).reduce((s, p) => s + p.amount, 0)),
      unconfirmed: round2(db.payments.filter((p) => p.status === 'unconfirmed').reduce((s, p) => s + p.amount, 0)),
      unapplied: round2(db.payments.filter((p) => p.unapplied).reduce((s, p) => s + p.amount, 0)),
    },
  };
}
export function verifyPayment(id, body) {
  requireConfirm(body, 'verify this payment against bank records');
  const p = db.payments.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Payment not found');
  if (p.status === 'verified') throw new HttpError(409, 'Payment already verified.');
  if (!body.bankReference || !String(body.bankReference).trim()) throw new HttpError(400, 'Bank transaction reference is required to verify a payment.');
  Object.assign(p, { status: 'verified', verifiedBy: body.reviewer, verifiedAt: asOf(), bankReference: body.bankReference });
  log(body.reviewer, 'payment_verified', p.invoiceId, `Payment ${p.id} (${fmtUSD(p.amount)}) verified against bank reference ${body.bankReference}.`);
  return { payment: p, invoice: p.invoiceId ? enrich(getInvoice(p.invoiceId)) : null };
}
export function applyPayment(id, body) {
  requireConfirm(body, 'apply this payment to an invoice');
  const p = db.payments.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Payment not found');
  if (!p.unapplied) throw new HttpError(409, 'Payment is already applied.');
  const inv = enrich(getInvoice(body.invoiceId));
  if (p.amount - inv.classification.balance > 0.005) throw new HttpError(422, `Payment ${fmtUSD(p.amount)} exceeds verified balance ${fmtUSD(inv.classification.balance)}. Split or review before applying.`);
  Object.assign(p, { invoiceId: inv.id, unapplied: false, appliedBy: body.reviewer, appliedAt: now() });
  log(body.reviewer, 'payment_applied', inv.id, `Verified deposit ${p.id} (${fmtUSD(p.amount)}) applied to ${inv.number}.`);
  return { payment: p, invoice: enrich(getInvoice(inv.id)) };
}
export function rejectPaymentClaim(id, { reviewer = 'J. Whitfield', reason = '' } = {}) {
  const p = db.payments.find((x) => x.id === id);
  if (!p || p.status !== 'unconfirmed') throw new HttpError(409, 'Only unconfirmed payment claims can be dismissed.');
  p.status = 'dismissed';
  log(reviewer, 'payment_claim_dismissed', p.invoiceId, `Unconfirmed payment claim ${p.id} dismissed${reason ? `: ${reason}` : ''}.`);
  return p;
}

// ---------- Extraction ----------
export const listSamples = () => sampleDocuments.map(({ id, label, s3Key, text }) => ({ id, label, s3Key, text }));
export async function runExtraction({ sampleId, text, actor = 'J. Whitfield' }) {
  const sample = sampleDocuments.find((s) => s.id === sampleId);
  const sourceText = sample?.text ?? text;
  if (!sourceText) throw new HttpError(400, 'Provide a sampleId or invoice text.');
  let result; let engine = 'Text parser (demo mode — stands in for Amazon Textract AnalyzeExpense)';
  if (MODE === 'aws' && sample && process.env.INVOICE_BUCKET) {
    try { result = await textractAnalyzeExpense({ bucket: process.env.INVOICE_BUCKET, key: sample.s3Key }); engine = 'Amazon Textract AnalyzeExpense'; } catch (e) { engine += ` — Textract unavailable: ${e.message}`; }
  }
  result ||= parseInvoiceText(sourceText);
  const check = checkExtraction(result, db.customers);
  const rec = { id: `EXT-${db.counters.extraction++}`, createdAt: now(), source: sample ? sample.label : 'Pasted text', s3Key: sample?.s3Key || null, engine, ...result, check, status: 'pending_review', text: sourceText };
  db.extractions.push(rec);
  log(actor, 'extraction_run', null, `Extraction ${rec.id} completed with ${check.issues.filter((i) => i.severity === 'block').length} blocking issue(s); awaiting human review.`);
  return rec;
}
export function confirmExtraction(id, body) {
  requireConfirm(body, 'create an invoice record from this extraction');
  const x = db.extractions.find((e) => e.id === id);
  if (!x) throw new HttpError(404, 'Extraction not found');
  if (x.status !== 'pending_review') throw new HttpError(409, `Extraction is ${x.status}.`);
  const blocks = x.check.issues.filter((i) => i.severity === 'block');
  if (blocks.length && body.overrideBlocking !== true) throw new HttpError(422, 'Blocking issues must be corrected at source or explicitly routed to review: ' + blocks.map((b) => b.message).join(' '));
  if (!x.check.customerId) throw new HttpError(422, 'Cannot create an invoice without a matched customer record.');
  const v = (k) => x.fields[k]?.value;
  if (db.invoices.some((i) => i.number === v('invoiceNumber'))) throw new HttpError(409, `Invoice ${v('invoiceNumber')} already exists.`);
  const cust = db.customers.find((c) => c.id === x.check.customerId);
  const termsDays = Number(String(v('paymentTerms') || '').match(/\d+/)?.[0] || cust.termsDays);
  const inv = {
    id: v('invoiceNumber'), number: v('invoiceNumber'), customerId: cust.id, issueDate: v('issueDate'), dueDate: v('dueDate') || addDays(v('issueDate'), termsDays),
    paymentTerms: `Net ${termsDays}`, currency: 'USD', poNumber: v('poNumber'),
    lineItems: x.lineItems.map((l, i) => ({ line: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, taxable: true })),
    subtotal: v('subtotal') ?? x.check.lineSum, tax: v('tax') ?? 0, total: v('total'), source: 'textract_extraction', documentId: x.id,
    reviewFlags: blocks.map((b) => ({ code: 'EXTRACTION', message: `Extraction issue: ${b.message}` })),
  };
  db.invoices.push(inv);
  x.status = 'confirmed'; x.invoiceId = inv.id; x.confirmedBy = body.reviewer;
  log(body.reviewer, 'invoice_created', inv.id, `Invoice ${inv.number} created from extraction ${x.id}${blocks.length ? ' and routed to review' : ''}.`);
  return enrich(inv);
}

// ---------- Activity, settings, marketing ----------
export const listActivity = () => [...db.activity].sort((a, b) => b.at.localeCompare(a.at));
export const getSettings = () => db.settings;
export function updateSettings(body) {
  if (body.autoSendReminders === true || body.autoMarkPaid === true) throw new HttpError(403, 'Automatic sending and automatic paid-marking are locked off in InvoiceHarbor.');
  const w = body.weights || {};
  for (const k of Object.keys(db.settings.weights)) if (w[k] != null && Number.isFinite(Number(w[k]))) db.settings.weights[k] = Math.max(0, Math.min(100, Number(w[k])));
  for (const k of ['reminderCooldownDays', 'escalationDays', 'balanceCap', 'overdueCapDays', 'upcomingWindowDays']) if (body[k] != null && Number(body[k]) > 0) db.settings[k] = Number(body[k]);
  if (typeof body.requestUndisputedPortion === 'boolean') db.settings.requestUndisputedPortion = body.requestUndisputedPortion;
  log(body.actor || 'Admin', 'settings_updated', null, 'Prioritization rules updated.');
  return db.settings;
}
export function addDemoRequest(body) {
  const required = ['name', 'email', 'company'];
  for (const k of required) if (!body?.[k] || !String(body[k]).trim()) throw new HttpError(400, `${k} is required.`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) throw new HttpError(400, 'A valid work email is required.');
  const rec = {
    id: `LEAD-${marketing.demoRequests.length + 1}`, receivedAt: now(),
    name: String(body.name).slice(0, 120), email: String(body.email).slice(0, 200), company: String(body.company).slice(0, 160),
    role: String(body.role || '').slice(0, 120), segment: String(body.segment || '').slice(0, 60), invoiceVolume: String(body.invoiceVolume || '').slice(0, 40),
    message: String(body.message || '').slice(0, 2000), consent: body.consent === true,
    hubspot: { status: 'queued', note: 'Would sync to HubSpot Contacts + Deals (pipeline "InvoiceHarbor Sales", stage "Demo requested"). No financial data is ever attached.' },
  };
  marketing.demoRequests.push(rec);
  return { id: rec.id, status: 'received', hubspot: rec.hubspot.status };
}
export const listDemoRequests = () => marketing.demoRequests;
