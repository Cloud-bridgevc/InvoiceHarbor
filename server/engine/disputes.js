// Dispute intelligence: summarise correspondence, find missing information,
// unresolved questions, and next steps. Amounts always come from the dispute record.

import { round2, fmtUSD, daysBetween } from './core.js';
import { MODE, bedrockJSON } from '../aws/adapters.js';

export const REQUIRED_DOCS = {
  quantity_shortfall: ['invoice', 'purchase_order', 'packing_list', 'proof_of_delivery', 'carrier_bill_of_lading'],
  pricing: ['invoice', 'purchase_order', 'statement_of_work', 'change_order_or_approval'],
  damaged_goods: ['invoice', 'photos', 'delivery_receipt'],
  duplicate_billing: ['invoice', 'payment_history'],
};
const DOC_LABELS = {
  invoice: 'Invoice copy', purchase_order: 'Purchase order', packing_list: 'Packing list', proof_of_delivery: 'Signed proof of delivery',
  carrier_bill_of_lading: 'Carrier bill of lading', statement_of_work: 'Signed statement of work', change_order_or_approval: 'Change order or written approval for extra work',
  photos: 'Photos of damage', delivery_receipt: 'Delivery receipt', payment_history: 'Payment history',
};

const CATEGORY_NEXT_STEPS = {
  quantity_shortfall: [
    'Obtain the signed proof of delivery and carrier bill of lading for the shipment.',
    'Reconcile the pick ticket against the packing list to confirm shipped quantity.',
    'If the shortfall is confirmed, prepare a credit note for approval; if not, share delivery evidence with the customer.',
  ],
  pricing: [
    'Retrieve the signed statement of work and any change orders for the billing period.',
    'Confirm with the account owner whether the additional work was approved in writing.',
    'Either issue a corrected invoice / credit note or send the approval evidence to the customer.',
  ],
  damaged_goods: ['Review photos and delivery receipt.', 'Decide on replacement, credit, or rejection of claim.'],
};

function extractQuestions(text) {
  return text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => s.endsWith('?'));
}

export function analyzeDisputeRules(dispute, invoice, balance, asOf) {
  const msgs = dispute.messages || [];
  const customerMsgs = msgs.filter((m) => m.from === 'customer');
  const lastInternal = msgs.filter((m) => m.from === 'internal').map((m) => m.date).sort().pop();

  const questions = [];
  for (const m of customerMsgs) {
    for (const q of extractQuestions(m.body)) {
      const answered = lastInternal && lastInternal > m.date;
      questions.push({ question: q, askedOn: m.date, askedBy: m.author, status: answered ? 'acknowledged — confirm fully answered' : 'unanswered' });
    }
  }
  const required = REQUIRED_DOCS[dispute.category] || ['invoice'];
  const missing = required.filter((d) => !dispute.documentsOnFile.includes(d)).map((d) => ({ code: d, label: DOC_LABELS[d] || d }));

  const lastCustomer = customerMsgs.map((m) => m.date).sort().pop();
  const waitingOnUs = lastCustomer && (!lastInternal || lastCustomer > lastInternal);
  const daysOpen = daysBetween(dispute.openedDate, asOf);
  const disputed = Math.min(dispute.disputedAmount, balance);
  const undisputed = round2(Math.max(0, balance - disputed));

  const signals = [];
  const allText = customerMsgs.map((m) => m.body.toLowerCase()).join(' ');
  if (/holding|on hold|hold the/.test(allText)) signals.push('Customer states they are holding payment of the full invoice, including the undisputed portion.');
  if (/credit note|credit memo/.test(allText)) signals.push('Customer is requesting a credit note.');
  if (/will pay for what|pay the undisputed|pay for what we received/.test(allText)) signals.push('Customer has indicated willingness to pay for goods received.');
  if (/follow(ing)? up|any update|is there an update/.test(allText)) signals.push('Customer has had to follow up — response time is a relationship risk.');

  const catLabel = dispute.category.replace(/_/g, ' ');
  const summary = [
    `${invoice.customerName} disputes ${fmtUSD(disputed)} of ${invoice.number} (${catLabel}). The dispute has been open ${daysOpen} days.`,
    customerMsgs[0] ? `Initial claim (${customerMsgs[0].date}): ${firstSentence(customerMsgs[0].body)}` : '',
    waitingOnUs ? `The latest message is from the customer (${lastCustomer}); the next response is owed by our team.` : 'The latest message is from our team; awaiting the customer.',
    undisputed > 0 ? `${fmtUSD(undisputed)} of the verified balance is not under dispute.` : '',
  ].filter(Boolean).join(' ');

  const nextSteps = [...(CATEGORY_NEXT_STEPS[dispute.category] || ['Review correspondence and assign an owner.'])];
  if (missing.length) nextSteps.unshift(`Collect missing evidence: ${missing.map((m) => m.label).join(', ')}.`);
  if (waitingOnUs) nextSteps.push(`Reply to ${customerMsgs.at(-1).author} with a status update and expected resolution date.`);
  if (undisputed > 0) nextSteps.push(`Ask the customer to release the undisputed ${fmtUSD(undisputed)} while the ${catLabel} question is resolved.`);

  return {
    generator: 'rules', generatorLabel: 'InvoiceHarbor rules engine (demo mode)',
    summary, signals, unresolvedQuestions: questions, missingInformation: missing, nextSteps,
    figures: { balance, disputedAmount: disputed, undisputedAmount: undisputed, daysOpen, source: 'Dispute record + verified invoice balance' },
    waitingOn: waitingOnUs ? 'us' : 'customer',
  };
}

function firstSentence(t) {
  const s = t.split(/(?<=[.?!])\s+/);
  return (s[0].startsWith('Hi') && s[1] ? s[1] : s[0]).trim();
}

export async function analyzeDispute(dispute, invoice, balance, asOf) {
  const base = analyzeDisputeRules(dispute, invoice, balance, asOf);
  if (MODE !== 'aws') return base;
  try {
    const { data, modelId } = await bedrockJSON({
      system: 'You are a careful accounts receivable analyst. Summarise dispute correspondence factually. Never invent amounts, dates, or commitments. Use only the provided figures. Respond with JSON only.',
      prompt: JSON.stringify({
        task: 'Return {"summary": string, "unresolvedQuestions": [{"question": string, "askedOn": string, "status": string}], "nextSteps": [string], "signals": [string]}',
        invoice: { number: invoice.number, customer: invoice.customerName, dueDate: invoice.dueDate },
        figures: base.figures, missingInformation: base.missingInformation, messages: dispute.messages,
      }),
    });
    // Figures and missing documents remain rule-derived; the model only supplies narrative.
    return { ...base, ...pick(data, ['summary', 'unresolvedQuestions', 'nextSteps', 'signals']), generator: 'bedrock', generatorLabel: `Amazon Bedrock (${modelId})` };
  } catch (e) {
    return { ...base, generatorLabel: base.generatorLabel + ` — Bedrock unavailable: ${e.message}` };
  }
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k]).map((k) => [k, o[k]]));
