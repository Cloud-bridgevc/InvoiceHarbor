// Invoice data extraction. In AWS mode documents go to S3 and Amazon Textract
// AnalyzeExpense; in demo mode a text parser stands in. Either way, results are held
// for human confirmation and checked arithmetically before an invoice record is created.

import { round2, fmtUSD } from './core.js';

const num = (s) => {
  if (s == null) return null;
  const cleaned = String(s).replace(/[$,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
};

function field(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

export function parseInvoiceText(text) {
  const f = (value, confidence) => ({ value, confidence: value == null ? 0 : confidence });
  const fields = {
    invoiceNumber: f(field(text, [/Invoice\s*(?:No|#|Number)\.?:?\s*([A-Z0-9-]+)/i]), 0.98),
    issueDate: f(field(text, [/Invoice Date:\s*([\d-]{10})/i, /^Date:\s*([\d-]{10})/im]), 0.96),
    dueDate: f(field(text, [/Due Date:\s*([\d-]{10})/i]), 0.95),
    paymentTerms: f(field(text, [/(?:Payment )?Terms:\s*(.+)/i]), 0.93),
    customerName: f(field(text, [/Bill To:\s*(.+)/i]), 0.94),
    poNumber: f(field(text, [/PO (?:Number|#):?\s*([A-Z0-9-]+)/i]), 0.97),
    subtotal: f(num(field(text, [/Subtotal:\s*([\d,.]+)/i])), 0.97),
    tax: f(num(field(text, [/Tax:\s*([\d,.]+)/i])), 0.95),
    total: f(num(field(text, [/^\s*Total(?: Due)?:\s*([\d,.]+)/im])), 0.97),
  };
  const lineItems = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /Description\s+Qty/i.test(l));
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (!l.trim() || /^(Subtotal|Tax|Total)/i.test(l.trim())) break;
      const m = l.match(/^(.+?)\s{2,}(\S+)\s+([\d,.]+)\s+([\d,.]+)\s*$/);
      if (!m) continue;
      const qty = num(m[2]);
      lineItems.push({ description: m[1].trim(), quantity: qty, unitPrice: num(m[3]), amount: num(m[4]), confidence: qty == null ? 0.41 : 0.95, rawQuantity: m[2] });
    }
  }
  return { fields, lineItems };
}

export function checkExtraction({ fields, lineItems }, customers) {
  const issues = [];
  const v = (k) => fields[k]?.value;
  for (const k of ['invoiceNumber', 'issueDate', 'customerName', 'total']) if (v(k) == null) issues.push({ severity: 'block', field: k, message: `Required field "${k}" was not found.` });
  if (v('poNumber') == null) issues.push({ severity: 'warn', field: 'poNumber', message: 'No PO number found — some customers reject invoices without one.' });
  if (v('dueDate') == null) issues.push({ severity: 'info', field: 'dueDate', message: 'Due date not printed; it will be derived from payment terms.' });
  for (const [i, li] of lineItems.entries()) {
    if (li.quantity == null) issues.push({ severity: 'block', field: `line${i + 1}`, message: `Line ${i + 1}: quantity "${li.rawQuantity}" is unreadable (possible OCR error).` });
    else if (li.unitPrice != null && li.amount != null && Math.abs(round2(li.quantity * li.unitPrice) - li.amount) > 0.01)
      issues.push({ severity: 'warn', field: `line${i + 1}`, message: `Line ${i + 1}: ${li.quantity} × ${fmtUSD(li.unitPrice)} ≠ ${fmtUSD(li.amount)}.` });
  }
  const lineSum = round2(lineItems.reduce((s, l) => s + (l.amount || 0), 0));
  if (v('subtotal') != null && Math.abs(lineSum - v('subtotal')) > 0.01) issues.push({ severity: 'block', field: 'subtotal', message: `Line items sum to ${fmtUSD(lineSum)} but subtotal reads ${fmtUSD(v('subtotal'))}.` });
  const expectedTotal = round2((v('subtotal') ?? lineSum) + (v('tax') ?? 0));
  if (v('total') != null && Math.abs(expectedTotal - v('total')) > 0.01) issues.push({ severity: 'block', field: 'total', message: `Subtotal + tax = ${fmtUSD(expectedTotal)} but total reads ${fmtUSD(v('total'))} (difference ${fmtUSD(Math.abs(expectedTotal - v('total')))}).` });
  const customer = customers.find((c) => v('customerName') && c.name.toLowerCase() === v('customerName').toLowerCase());
  if (!customer && v('customerName')) issues.push({ severity: 'block', field: 'customerName', message: `"${v('customerName')}" does not match a customer record.` });
  for (const [k, fv] of Object.entries(fields)) if (fv.value != null && fv.confidence < 0.9) issues.push({ severity: 'warn', field: k, message: `Low confidence (${Math.round(fv.confidence * 100)}%).` });
  return { issues, lineSum, customerId: customer?.id || null, canAutoAccept: false, needsReview: issues.some((i) => i.severity !== 'info') };
}
