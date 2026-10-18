// Deterministic receivables engine. Every figure here is derived from recorded
// invoice and payment records — nothing is estimated unless explicitly labelled.

export const round2 = (n) => Math.round(n * 100) / 100;
export const fmtUSD = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
export const addDays = (iso, days) => {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const CLASS_LABELS = {
  current: 'Current',
  overdue: 'Overdue',
  disputed: 'Disputed',
  awaiting_information: 'Awaiting information',
  requires_review: 'Requires review',
  paid: 'Paid (verified)',
};

/** Balance = recorded total − verified payments applied. Unconfirmed payments never reduce the balance. */
export function balances(invoice, payments) {
  const applied = payments.filter((p) => p.invoiceId === invoice.id);
  const verified = round2(applied.filter((p) => p.status === 'verified').reduce((s, p) => s + p.amount, 0));
  const unconfirmed = round2(applied.filter((p) => p.status === 'unconfirmed').reduce((s, p) => s + p.amount, 0));
  return { total: invoice.total, verifiedPaid: verified, unconfirmedClaimed: unconfirmed, balance: round2(invoice.total - verified) };
}

export function classify(invoice, db, asOf) {
  const b = balances(invoice, db.payments);
  const daysOverdue = Math.max(0, daysBetween(invoice.dueDate, asOf));
  const dispute = db.disputes.find((d) => d.invoiceId === invoice.id && d.status === 'open');
  const infoRequest = db.infoRequests.find((r) => r.invoiceId === invoice.id && r.status === 'open');
  const reasons = [];
  const reviewReasons = [];

  for (const f of invoice.reviewFlags || []) reviewReasons.push(f.message);
  if (b.unconfirmedClaimed > 0) reviewReasons.push(`${fmtUSD(b.unconfirmedClaimed)} payment claimed by customer but not yet confirmed in bank records — balance unchanged until verified.`);
  if (b.balance < -0.004) reviewReasons.push(`Verified payments exceed the invoice total by ${fmtUSD(-b.balance)} (possible overpayment or misapplication).`);

  let cls;
  if (Math.abs(b.balance) < 0.005 && b.verifiedPaid > 0 && reviewReasons.length === 0) {
    cls = 'paid';
    reasons.push(`Verified payments of ${fmtUSD(b.verifiedPaid)} cover the recorded total of ${fmtUSD(b.total)}.`);
  } else if (reviewReasons.length) {
    cls = 'requires_review';
    reasons.push(...reviewReasons);
  } else if (dispute) {
    cls = 'disputed';
    reasons.push(`Open dispute ${dispute.id} (${dispute.category.replace(/_/g, ' ')}) covering ${fmtUSD(dispute.disputedAmount)}.`);
  } else if (infoRequest) {
    cls = 'awaiting_information';
    reasons.push(`Open information request ${infoRequest.id}: ${infoRequest.item}.`);
  } else if (daysOverdue > 0) {
    cls = 'overdue';
    reasons.push(`Due ${invoice.dueDate}; ${daysOverdue} days past due with ${fmtUSD(b.balance)} unpaid per verified records.`);
  } else {
    cls = 'current';
    reasons.push(`Not yet due — due ${invoice.dueDate} (in ${daysBetween(asOf, invoice.dueDate)} days).`);
  }
  if (cls !== 'overdue' && cls !== 'paid' && daysOverdue > 0) reasons.push(`Also ${daysOverdue} days past due (due ${invoice.dueDate}).`);

  const flags = [];
  if (daysOverdue > 0 && cls !== 'paid') flags.push('overdue');
  if (dispute) flags.push('disputed');
  if (b.verifiedPaid > 0 && b.balance > 0.005) flags.push('partially_paid');
  if (b.unconfirmedClaimed > 0) flags.push('unconfirmed_payment');

  return { class: cls, label: CLASS_LABELS[cls], flags, reasons, daysOverdue, ...b, disputeId: dispute?.id || null, infoRequestId: infoRequest?.id || null };
}

export function agingBucket(daysOverdue) {
  if (daysOverdue <= 0) return 'Current';
  if (daysOverdue <= 30) return '1–30';
  if (daysOverdue <= 60) return '31–60';
  if (daysOverdue <= 90) return '61–90';
  return '90+';
}
export const BUCKETS = ['Current', '1–30', '31–60', '61–90', '90+'];

/** Transparent priority score: each factor contributes visible, configurable points. */
export function prioritize(invoice, c, db, asOf) {
  const s = db.settings;
  const w = s.weights;
  const cust = db.customers.find((x) => x.id === invoice.customerId);
  const factors = [];
  if (c.class === 'paid' || c.balance <= 0.005) return null;
  const daysToDue = daysBetween(asOf, invoice.dueDate);
  if (c.daysOverdue === 0 && daysToDue > s.upcomingWindowDays && c.class === 'current') return null;

  if (c.daysOverdue > 0) {
    const pts = round2((Math.min(c.daysOverdue, s.overdueCapDays) / s.overdueCapDays) * w.overdue);
    factors.push({ key: 'overdue', label: 'Overdue duration', points: pts, detail: `${c.daysOverdue} days past due (capped at ${s.overdueCapDays})` });
  } else {
    factors.push({ key: 'upcoming', label: 'Due soon', points: 2, detail: `Due in ${daysToDue} days` });
  }
  const notDue = c.daysOverdue === 0;
  const balPts = round2((Math.min(c.balance, s.balanceCap) / s.balanceCap) * w.balance * (notDue ? 0.25 : 1));
  factors.push({ key: 'balance', label: 'Verified balance', points: balPts, detail: `${fmtUSD(c.balance)} outstanding (capped at ${fmtUSD(s.balanceCap)})${notDue ? '; weighted at 25% while not yet due' : ''}` });

  if (c.disputeId) factors.push({ key: 'dispute', label: 'Open dispute', points: w.dispute, detail: `${c.disputeId} needs resolution before collection` });
  const promise = db.promises.find((p) => p.invoiceId === invoice.id && p.status === 'broken');
  if (promise) factors.push({ key: 'brokenPromise', label: 'Broken promise to pay', points: w.brokenPromise, detail: `Promised ${promise.promisedDate}; no verified payment received` });
  if (c.infoRequestId) factors.push({ key: 'awaitingInfo', label: 'Information outstanding', points: w.awaitingInfo, detail: `${c.infoRequestId} blocks customer processing` });
  if (c.class === 'requires_review') factors.push({ key: 'review', label: 'Data review needed', points: 6, detail: 'Record must be reviewed before any customer contact' });
  if (cust?.keyAccount) factors.push({ key: 'keyAccount', label: 'Key account rule', points: w.keyAccount, detail: 'Configured business rule: key accounts get earlier personal attention' });

  const lastContact = db.reminders
    .filter((r) => r.invoiceId === invoice.id && r.status === 'sent_externally' && r.sentAt)
    .map((r) => r.sentAt.slice(0, 10)).sort().pop();
  if (lastContact) {
    const since = daysBetween(lastContact, asOf);
    if (since < s.reminderCooldownDays) factors.push({ key: 'recentContact', label: 'Recently contacted', points: -w.recentContactPenalty, detail: `Last reminder ${since} days ago (cooldown ${s.reminderCooldownDays} days)` });
  }

  const score = round2(factors.reduce((t, f) => t + f.points, 0));
  return { score, factors, recommendedAction: recommendAction(c, promise), lastContact: lastContact || null };
}

function recommendAction(c, promise) {
  if (c.class === 'requires_review') return { code: 'review', label: 'Review record before contact' };
  if (c.class === 'disputed') return { code: 'resolve_dispute', label: 'Advance dispute; request undisputed portion' };
  if (c.class === 'awaiting_information') return { code: 'provide_info', label: 'Send requested information' };
  if (promise) return { code: 'follow_up_promise', label: 'Follow up on missed promise' };
  if (c.daysOverdue > 0) return { code: 'remind', label: 'Draft payment reminder' };
  return { code: 'courtesy', label: 'Optional pre-due courtesy note' };
}

/**
 * Payment-timing ESTIMATE based on the customer's verified payment history.
 * Always returned with kind:'estimate' so the UI never presents it as a verified fact.
 */
export function estimatePaymentTiming(invoice, c, db, asOf) {
  if (c.class === 'paid') {
    const last = db.payments.filter((p) => p.invoiceId === invoice.id && p.status === 'verified').map((p) => p.receivedDate).sort().pop();
    return { kind: 'verified', date: last, basis: 'Verified payment recorded in bank records.' };
  }
  if (c.disputeId) return { kind: 'estimate', date: null, confidence: 'none', basis: 'No estimate — timing depends on dispute resolution.' };
  if (c.class === 'requires_review') return { kind: 'estimate', date: null, confidence: 'none', basis: 'No estimate until the record review is complete.' };
  const history = db.invoices
    .filter((i) => i.customerId === invoice.customerId && i.id !== invoice.id)
    .map((i) => {
      const paid = db.payments.filter((p) => p.invoiceId === i.id && p.status === 'verified');
      const sum = paid.reduce((s, p) => s + p.amount, 0);
      if (Math.abs(sum - i.total) > 0.005) return null;
      return daysBetween(i.dueDate, paid.map((p) => p.receivedDate).sort().pop());
    })
    .filter((x) => x !== null);
  if (!history.length) return { kind: 'estimate', date: null, confidence: 'none', basis: 'No verified payment history for this customer.' };
  const avgLate = Math.round(history.reduce((s, d) => s + d, 0) / history.length);
  let date = addDays(invoice.dueDate, avgLate);
  if (date < asOf) date = addDays(asOf, 7);
  return {
    kind: 'estimate', date, confidence: history.length >= 3 ? 'medium' : 'low',
    basis: `Based on ${history.length} fully paid invoice${history.length > 1 ? 's' : ''}; customer paid on average ${Math.abs(avgLate)} days ${avgLate >= 0 ? 'after' : 'before'} due date. Not a commitment.`,
  };
}
