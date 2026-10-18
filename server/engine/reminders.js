// AI reminder drafting. Drafts are ALWAYS created as "pending_approval" and are never
// sent by InvoiceHarbor. Every currency amount in a draft is validated against the
// recorded figures for that invoice before it can be approved.

import { fmtUSD, round2 } from './core.js';
import { MODE, bedrockJSON } from '../aws/adapters.js';

export function chooseTone(c, settings) {
  if (c.class === 'disputed') return 'dispute_aware';
  if (c.class === 'awaiting_information') return 'informational';
  if (c.daysOverdue === 0) return 'courtesy';
  if (c.daysOverdue <= 14) return 'friendly';
  if (c.daysOverdue < settings.escalationDays) return 'firm';
  return 'escalated';
}

export const TONE_LABELS = {
  courtesy: 'Courtesy (pre-due)', friendly: 'Friendly reminder', firm: 'Firm follow-up', escalated: 'Escalated (account review)',
  dispute_aware: 'Dispute-aware', informational: 'Information response',
};

/** Amounts a draft is allowed to mention, each tied to its source record. */
export function allowedFacts(ctx) {
  const { invoice, c, dispute } = ctx;
  const facts = [
    { label: 'Invoice total', amount: invoice.total, source: `Invoice ${invoice.number}` },
    { label: 'Verified balance', amount: c.balance, source: 'Invoice total − verified payments' },
  ];
  if (c.verifiedPaid > 0) facts.push({ label: 'Verified payments received', amount: c.verifiedPaid, source: 'Verified payment records' });
  if (dispute) {
    const disputed = Math.min(dispute.disputedAmount, c.balance);
    facts.push({ label: 'Disputed amount', amount: disputed, source: `Dispute ${dispute.id}` });
    facts.push({ label: 'Undisputed balance', amount: round2(c.balance - disputed), source: 'Verified balance − disputed amount' });
  }
  return facts;
}

export function validateDraft(body, facts, ctx) {
  const issues = [];
  const allowed = new Set(facts.map((f) => f.amount.toFixed(2)));
  const found = [...body.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, '')).toFixed(2));
  for (const a of found) if (!allowed.has(a)) issues.push({ severity: 'block', message: `Amount $${a} does not match any recorded figure for this invoice.` });
  if (/\b(paid in full|has been paid|payment (was )?received|thank you for your payment)\b/i.test(body) && ctx.c.verifiedPaid < ctx.invoice.total)
    issues.push({ severity: 'block', message: 'Draft implies payment has been received, but verified records do not show full payment.' });
  if (/\b(legal action|collections agency|lawsuit|court|credit bureau)\b/i.test(body))
    issues.push({ severity: 'block', message: 'Draft references legal or collections escalation — requires a policy-approved template, not AI drafting.' });
  if (ctx.dispute && new RegExp(fmtUSD(ctx.c.balance).replace(/[$.]/g, '\\$&') + '[^.]*\\b(immediately|now|today)\\b', 'i').test(body))
    issues.push({ severity: 'warn', message: 'Draft appears to demand the full balance while a dispute is open.' });
  if (/\b(will be paid|expected to pay|you will pay) (on|by)\b/i.test(body))
    issues.push({ severity: 'warn', message: 'Draft states a payment date as fact — estimated timing must not be presented as confirmed.' });
  return { ok: !issues.some((i) => i.severity === 'block'), issues };
}

function templateDraft(ctx, tone) {
  const { invoice, customer, c, dispute, infoRequest, settings, sender } = ctx;
  const first = customer.contact.name.split(' ')[0];
  const sign = `\n\nKind regards,\n${sender.name}\n${sender.title}, Accounts Receivable\n${sender.company}`;
  const ref = `${invoice.number} (issued ${invoice.issueDate}, PO ${invoice.poNumber || 'not provided'})`;

  if (tone === 'dispute_aware') {
    const disputed = Math.min(dispute.disputedAmount, c.balance);
    const undisputed = round2(c.balance - disputed);
    const cat = dispute.category.replace(/_/g, ' ');
    const ask = settings.requestUndisputedPortion && undisputed > 0
      ? `\n\nWhile we resolve that question, would you be able to release the undisputed portion of ${fmtUSD(undisputed)}? This covers the items that are not in question, and we will treat the remaining ${fmtUSD(disputed)} separately once the review is complete.`
      : '';
    const evidence = {
      quantity_shortfall: ['gathering the delivery documentation (including the signed proof of delivery and carrier records) so we can confirm the shipped quantity', 'issue a credit note for any confirmed shortfall'],
      pricing: ['retrieving the signed statement of work and any written approvals for the additional work so we can confirm the billed charges', 'issue a corrected invoice or credit note if the charges are not supported'],
      damaged_goods: ['reviewing the delivery receipt and photos of the affected items', 'arrange a credit or replacement for any confirmed damage'],
    }[dispute.category] || ['reviewing the documentation for this invoice', 'correct the invoice if needed'];
    const onHold = (dispute.messages || []).some((m) => m.from === 'customer' && /holding|on hold/i.test(m.body));
    return {
      subject: `Update on ${invoice.number} — ${cat} review`,
      body: `Hi ${first},\n\nThank you for your patience regarding ${ref}. We have not forgotten your query about the ${cat}, and I want to give you a clear update.\n\nOur team is ${evidence[0]}. As soon as we have reviewed it, we will either ${evidence[1]} or share the supporting paperwork with you.${ask}\n\n${onHold ? 'I understand the full invoice is currently on hold in your AP system. ' : ''}If it helps, I am happy to arrange a short call to agree next steps.${sign}`,
    };
  }
  if (tone === 'informational') {
    return {
      subject: `Information for ${invoice.number}`,
      body: `Hi ${first},\n\nFollowing your request regarding ${ref}, you asked for the following before processing: ${infoRequest.item.toLowerCase()}.\n\n[Staff: insert the requested ${infoRequest.item.toLowerCase()} here before approving.]\n\nThe verified balance on this invoice is ${fmtUSD(c.balance)}. Once you have what you need, please let me know if anything else is required to process it.${sign}`,
    };
  }
  const opening = {
    courtesy: `This is a courtesy note that ${ref} for ${fmtUSD(c.balance)} is due on ${invoice.dueDate}.`,
    friendly: `I hope all is well. Our records show that ${ref} was due on ${invoice.dueDate}, and a balance of ${fmtUSD(c.balance)} remains open. It may simply have crossed with a payment in transit — if so, please disregard this note.`,
    firm: `I am following up on ${ref}, which was due on ${invoice.dueDate} and is now ${c.daysOverdue} days past due. The verified outstanding balance is ${fmtUSD(c.balance)}.`,
    escalated: `I am writing about ${ref}, which is now ${c.daysOverdue} days past due with a verified outstanding balance of ${fmtUSD(c.balance)}. As the balance has been open for some time, our account review process has flagged it for priority attention.`,
  }[tone];
  const partial = c.verifiedPaid > 0 ? `\n\nThank you for the ${fmtUSD(c.verifiedPaid)} already received and recorded against this invoice.` : '';
  const close = {
    courtesy: 'If you need a copy of the invoice or any supporting documents, just reply to this email.',
    friendly: 'Could you let me know when we can expect payment, or whether anything is needed from our side to process it?',
    firm: 'Please let me know the expected payment date, or if there is an issue preventing payment so we can help resolve it.',
    escalated: 'Please contact me within the next five business days to confirm a payment date or to discuss any issue with the invoice. I would like to resolve this together.',
  }[tone];
  return { subject: `${tone === 'courtesy' ? 'Upcoming' : 'Payment reminder'}: ${invoice.number}`, body: `Hi ${first},\n\n${opening}${partial}\n\n${close}${sign}` };
}

export async function draftReminder(ctx, requestedTone) {
  const tone = requestedTone || chooseTone(ctx.c, ctx.settings);
  const facts = allowedFacts(ctx);
  let draft = templateDraft(ctx, tone);
  let generator = 'template';
  let generatorLabel = 'InvoiceHarbor drafting engine (demo mode)';

  if (MODE === 'aws') {
    try {
      const { data, modelId } = await bedrockJSON({
        system: 'You draft professional, courteous accounts receivable emails for staff review. Use ONLY the amounts and dates provided. Never claim a payment was received unless stated. Never threaten legal action. If a dispute is open, acknowledge it and do not demand the disputed amount. Respond with JSON {"subject": string, "body": string}.',
        prompt: JSON.stringify({ tone, facts, invoice: { number: ctx.invoice.number, issueDate: ctx.invoice.issueDate, dueDate: ctx.invoice.dueDate, po: ctx.invoice.poNumber, daysOverdue: ctx.c.daysOverdue }, contactFirstName: ctx.customer.contact.name.split(' ')[0], dispute: ctx.dispute ? { category: ctx.dispute.category, status: ctx.dispute.status } : null, sender: ctx.sender, referenceDraft: draft }),
      });
      const v = validateDraft(data.body || '', facts, ctx);
      if (v.ok) { draft = data; generator = 'bedrock'; generatorLabel = `Amazon Bedrock (${modelId})`; }
      else generatorLabel += ' — Bedrock draft rejected by amount validation';
    } catch (e) {
      generatorLabel += ` — Bedrock unavailable: ${e.message}`;
    }
  }
  const validation = validateDraft(draft.body, facts, ctx);
  const sensitive = ['firm', 'escalated', 'dispute_aware'].includes(tone);
  return { ...draft, tone, toneLabel: TONE_LABELS[tone], facts, validation, generator, generatorLabel, sensitive };
}
