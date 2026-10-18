// Fictional demonstration data. All companies, people, and amounts are invented.
// The "as of" date for the demo is fixed so aging and overdue figures are reproducible.

export const DEMO_AS_OF = process.env.DEMO_AS_OF || '2026-10-18';

const addDays = (iso, days) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const round2 = (n) => Math.round(n * 100) / 100;

export const customers = [
  { id: 'C-101', name: 'Brightwater Logistics', segment: 'Distributor', termsDays: 30, contact: { name: 'Dana Okafor', role: 'AP Manager', email: 'ap@brightwater-logistics.example' }, creditLimit: 40000, keyAccount: true, region: 'Midwest' },
  { id: 'C-102', name: 'Cedar & Pike Distribution', segment: 'Distributor', termsDays: 45, contact: { name: 'Marcus Lindqvist', role: 'Accounts Payable Lead', email: 'payables@cedarpike.example' }, creditLimit: 35000, keyAccount: true, region: 'Northeast' },
  { id: 'C-103', name: 'Halden Creative Agency', segment: 'Agency', termsDays: 30, contact: { name: 'Priya Ramaswamy', role: 'Finance Coordinator', email: 'finance@haldencreative.example' }, creditLimit: 20000, keyAccount: false, region: 'West' },
  { id: 'C-104', name: 'Marlow Foodservice Supply', segment: 'Distributor', termsDays: 30, contact: { name: 'Tom Achterberg', role: 'Controller', email: 'controller@marlowfoods.example' }, creditLimit: 30000, keyAccount: false, region: 'South' },
  { id: 'C-105', name: 'Solenne Media Group', segment: 'Agency', termsDays: 15, contact: { name: 'Inès Kowalczyk', role: 'Billing Manager', email: 'billing@solenne.example' }, creditLimit: 25000, keyAccount: false, region: 'Northeast' },
  { id: 'C-106', name: 'Tarnby Industrial Parts', segment: 'Distributor', termsDays: 60, contact: { name: 'Gareth Mbeki', role: 'Procurement & AP', email: 'ap@tarnby.example' }, creditLimit: 60000, keyAccount: true, region: 'Midwest' },
  { id: 'C-107', name: 'Quayside Retail Co.', segment: 'Retail', termsDays: 30, contact: { name: 'Hannah Voss', role: 'AP Specialist', email: 'invoices@quaysideretail.example' }, creditLimit: 15000, keyAccount: false, region: 'West' },
  { id: 'C-108', name: 'Vireo Health Supplies', segment: 'Distributor', termsDays: 30, contact: { name: 'Samuel Adeyemi', role: 'AP Supervisor', email: 'ap@vireohealth.example' }, creditLimit: 25000, keyAccount: false, region: 'South' },
];

function inv(number, customerId, issueDate, lines, { taxRate = 0, termsDays, poNumber = null, source = 'erp_import', recordedTotal, reviewFlags = [], documentId = null } = {}) {
  const cust = customers.find((c) => c.id === customerId);
  const terms = termsDays ?? cust.termsDays;
  const lineItems = lines.map(([description, quantity, unitPrice, taxable = true], i) => ({
    line: i + 1, description, quantity, unitPrice, amount: round2(quantity * unitPrice), taxable,
  }));
  const subtotal = round2(lineItems.reduce((s, l) => s + l.amount, 0));
  const tax = round2(lineItems.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0) * taxRate);
  const computedTotal = round2(subtotal + tax);
  return {
    id: number, number, customerId, issueDate, dueDate: addDays(issueDate, terms),
    paymentTerms: `Net ${terms}`, currency: 'USD', poNumber, lineItems, subtotal, tax, taxRate,
    total: recordedTotal ?? computedTotal, source, reviewFlags, documentId,
  };
}

export function buildSeed() {
  const invoices = [
    inv('INV-2026-1001', 'C-101', '2026-07-10', [['Regional LTL freight coordination — July', 1, 6200, false], ['Cross-dock handling (pallets)', 84, 22.5]], { taxRate: 0.06, poNumber: 'BW-44120' }),
    inv('INV-2026-1002', 'C-101', '2026-09-01', [['Regional LTL freight coordination — August', 1, 6850, false], ['Cross-dock handling (pallets)', 96, 22.5]], { taxRate: 0.06, poNumber: 'BW-44388' }),
    inv('INV-2026-1003', 'C-101', '2026-10-05', [['Regional LTL freight coordination — September', 1, 7120, false]], { poNumber: 'BW-44601' }),
    inv('INV-2026-1004', 'C-102', '2026-07-20', [['Stretch film, 18in x 1500ft (roll)', 160, 42.5], ['Edge protectors, 48in (case)', 30, 18]], { taxRate: 0.06, poNumber: 'CP-7781' }),
    inv('INV-2026-1005', 'C-102', '2026-08-10', [['Stretch film, 18in x 1500ft (roll)', 120, 42.5], ['Poly strapping kit', 12, 96]], { taxRate: 0.06, poNumber: 'CP-7840' }),
    inv('INV-2026-1007', 'C-102', '2026-07-27', [['Stretch film, 18in x 1500ft (roll)', 200, 42.5], ['Edge protectors, 48in (case)', 40, 18], ['Freight — 2 pallets, LTL', 1, 385, false]], { taxRate: 0.06, poNumber: 'CP-7802', documentId: 'DOC-1007' }),
    inv('INV-2026-1008', 'C-103', '2026-08-15', [['Brand refresh — phase 2 production', 1, 8400, false], ['Stock imagery licences', 6, 145, false]]),
    inv('INV-2026-1009', 'C-103', '2026-09-20', [['Campaign asset adaptation — Q4', 1, 3950, false]], { poNumber: 'HCA-2209' }),
    inv('INV-2026-1010', 'C-104', '2026-06-15', [['Insulated food pans, full size (case)', 140, 64], ['Disposable glove cases (nitrile)', 180, 21.5], ['Delivery — refrigerated', 1, 420, false]], { taxRate: 0.06, poNumber: 'MFS-3310' }),
    inv('INV-2026-1011', 'C-104', '2026-09-10', [['Disposable glove cases (nitrile)', 120, 21.5]], { taxRate: 0.06, poNumber: 'MFS-3392' }),
    inv('INV-2026-1012', 'C-105', '2026-09-25', [['Paid social management — September', 1, 5400, false]], { poNumber: 'SMG-118' }),
    inv('INV-2026-1013', 'C-105', '2026-08-01', [['Retainer — creative services (July)', 1, 7500, false], ['Additional revision rounds', 12, 165, false]], { poNumber: 'SMG-104' }),
    inv('INV-2026-1014', 'C-106', '2026-08-25', [['Hydraulic fittings assortment (kit)', 40, 310], ['Bearing units, pillow block', 160, 62.5]], { taxRate: 0, poNumber: 'TIP-90012' }),
    inv('INV-2026-1015', 'C-106', '2026-05-15', [['Bearing units, pillow block', 220, 62.5]], { poNumber: 'TIP-89870' }),
    inv('INV-2026-1016', 'C-107', '2026-09-05', [['Seasonal display fixtures', 18, 214], ['Installation labour (hours)', 6, 60, false]], { taxRate: 0.0 , poNumber: 'QR-5531' }),
    inv('INV-2026-1017', 'C-107', '2026-07-01', [['POS signage refresh — 12 stores', 12, 485, false], ['Shipping', 1, 260, false]], { poNumber: 'QR-5402' }),
    inv('INV-2026-1018', 'C-108', '2026-10-01', [['Exam table paper rolls (case)', 90, 38], ['Sanitizing wipes (case)', 60, 44]], { taxRate: 0.06, poNumber: 'VHS-2271' }),
    inv('INV-2026-1019', 'C-108', '2026-08-20', [['Exam table paper rolls (case)', 70, 38], ['Sanitizing wipes (case)', 50, 44]], {
      poNumber: 'VHS-2180', source: 'textract_extraction', recordedTotal: 4980.0, documentId: 'DOC-1019',
      reviewFlags: [{ code: 'TOTAL_MISMATCH', message: 'Extracted invoice total ($4,980.00) does not equal the sum of extracted line items ($4,860.00). Difference: $120.00.' }],
    }),
    inv('INV-2026-1020', 'C-104', '2026-10-12', [['Insulated food pans, full size (case)', 60, 64]], { taxRate: 0.06, poNumber: 'MFS-3420' }),
    inv('INV-2026-1021', 'C-102', '2026-09-28', [['Stretch film, 18in x 1500ft (roll)', 180, 42.5]], { taxRate: 0.06, poNumber: 'CP-7911' }),
    inv('INV-2026-1022', 'C-103', '2026-07-05', [['Brand refresh — phase 1 discovery', 1, 5600, false]], { poNumber: 'HCA-2140' }),
  ];

  const total = (id) => invoices.find((i) => i.id === id).total;

  // Payment status: "verified" = confirmed against bank records; "unconfirmed" = remittance advice or customer claim only.
  const payments = [
    { id: 'PAY-5001', invoiceId: 'INV-2026-1001', amount: total('INV-2026-1001'), receivedDate: '2026-08-07', method: 'ACH', reference: 'BWL ACH 880211', status: 'verified', source: 'bank_feed', verifiedBy: 'R. Castellano', verifiedAt: '2026-08-08' },
    { id: 'PAY-5002', invoiceId: 'INV-2026-1004', amount: total('INV-2026-1004'), receivedDate: '2026-09-12', method: 'Wire', reference: 'CEDARPIKE INV1004', status: 'verified', source: 'bank_feed', verifiedBy: 'R. Castellano', verifiedAt: '2026-09-12' },
    { id: 'PAY-5003', invoiceId: 'INV-2026-1005', amount: 3000.0, receivedDate: '2026-09-30', method: 'ACH', reference: 'CP PARTIAL 1005', status: 'verified', source: 'bank_feed', verifiedBy: 'J. Whitfield', verifiedAt: '2026-10-01' },
    { id: 'PAY-5004', invoiceId: 'INV-2026-1015', amount: total('INV-2026-1015'), receivedDate: '2026-07-20', method: 'ACH', reference: 'TARNBY 89870', status: 'verified', source: 'bank_feed', verifiedBy: 'J. Whitfield', verifiedAt: '2026-07-21' },
    { id: 'PAY-5005', invoiceId: 'INV-2026-1017', amount: 2500.0, receivedDate: '2026-09-02', method: 'Check', reference: 'CHK 10443', status: 'verified', source: 'lockbox', verifiedBy: 'R. Castellano', verifiedAt: '2026-09-04' },
    { id: 'PAY-5006', invoiceId: 'INV-2026-1012', amount: 5400.0, receivedDate: '2026-10-14', method: 'ACH (claimed)', reference: 'Remittance advice SMG-RA-2231', status: 'unconfirmed', source: 'remittance_advice', verifiedBy: null, verifiedAt: null, note: 'Customer emailed remittance advice; funds not yet seen in bank feed.' },
    { id: 'PAY-5007', invoiceId: 'INV-2026-1022', amount: total('INV-2026-1022'), receivedDate: '2026-08-22', method: 'ACH', reference: 'HALDEN 2140', status: 'verified', source: 'bank_feed', verifiedBy: 'J. Whitfield', verifiedAt: '2026-08-23' },
    // Unapplied bank deposit waiting for reconciliation (verified funds, not yet matched to an invoice).
    { id: 'PAY-5008', invoiceId: null, amount: total('INV-2026-1016'), receivedDate: '2026-10-16', method: 'ACH', reference: 'QUAYSIDE RETAIL CO 5531', status: 'verified', source: 'bank_feed', verifiedBy: 'Bank feed', verifiedAt: '2026-10-16', unapplied: true },
  ];

  const disputes = [
    {
      id: 'DSP-301', invoiceId: 'INV-2026-1007', customerId: 'C-102', openedDate: '2026-09-04', status: 'open', category: 'quantity_shortfall',
      disputedAmount: 901.0, owner: 'J. Whitfield',
      documentsOnFile: ['invoice', 'purchase_order', 'packing_list'],
      messages: [
        { from: 'customer', author: 'Marcus Lindqvist', date: '2026-09-04', subject: 'INV-2026-1007 — short shipment',
          body: 'Hi, our receiving team counted 180 rolls of stretch film on the 7/29 delivery for PO CP-7802, not the 200 billed on INV-2026-1007. We will pay for what we received but need the invoice corrected or a credit note for the 20 missing rolls. Can you confirm whether the remaining 20 rolls were shipped separately? Also, can you send the signed proof of delivery?' },
        { from: 'internal', author: 'J. Whitfield', date: '2026-09-09', subject: 'RE: INV-2026-1007 — short shipment',
          body: 'Thanks Marcus. We have opened a dispute case and asked our warehouse to check the pick ticket and carrier records. We will come back to you once we have the delivery paperwork.' },
        { from: 'customer', author: 'Marcus Lindqvist', date: '2026-09-29', subject: 'RE: INV-2026-1007 — short shipment',
          body: 'Following up on this. We are holding the full invoice in our AP system until the quantity question is resolved. Is there an update on the carrier paperwork? What is the timeline for the credit note?' },
      ],
    },
    {
      id: 'DSP-302', invoiceId: 'INV-2026-1013', customerId: 'C-105', openedDate: '2026-08-21', status: 'open', category: 'pricing',
      disputedAmount: 1980.0, owner: 'R. Castellano',
      documentsOnFile: ['invoice'],
      messages: [
        { from: 'customer', author: 'Inès Kowalczyk', date: '2026-08-21', subject: 'Query on INV-2026-1013',
          body: 'Our statement of work says revision rounds are included in the retainer up to 15 per month. Why are 12 additional revision rounds billed separately? Please share the change order or approval for these.' },
      ],
    },
    {
      id: 'DSP-300', invoiceId: 'INV-2026-1004', customerId: 'C-102', openedDate: '2026-08-05', status: 'resolved', category: 'damaged_goods', resolvedDate: '2026-08-28',
      disputedAmount: 0, owner: 'J. Whitfield', resolution: 'Photos reviewed; damage was cosmetic packaging only. Customer accepted goods and paid in full.',
      documentsOnFile: ['invoice', 'photos', 'delivery_receipt'], messages: [],
    },
  ];

  const infoRequests = [
    { id: 'IR-401', invoiceId: 'INV-2026-1008', requestedBy: 'customer', requestedDate: '2026-09-18', status: 'open',
      item: 'Purchase order number', detail: 'Customer AP system rejects invoices without a PO number. Customer said a PO will be issued by their marketing lead.', },
  ];

  const promises = [
    { id: 'PTP-601', invoiceId: 'INV-2026-1010', promisedDate: '2026-09-30', amount: total('INV-2026-1010'), recordedBy: 'R. Castellano', recordedOn: '2026-09-16', status: 'broken' },
  ];

  const reminders = [
    { id: 'RMD-701', invoiceId: 'INV-2026-1010', createdAt: '2026-09-15T14:02:00Z', tone: 'firm', status: 'sent_externally', subject: 'Overdue invoice INV-2026-1010', body: '(Historical record — body retained in mailbox.)', approvedBy: 'R. Castellano', approvedAt: '2026-09-15T15:10:00Z', sentAt: '2026-09-15T15:20:00Z', generator: 'template', validation: { ok: true, issues: [] } },
    { id: 'RMD-702', invoiceId: 'INV-2026-1017', createdAt: '2026-10-13T09:30:00Z', tone: 'firm', status: 'sent_externally', subject: 'Balance remaining on INV-2026-1017', body: '(Historical record — body retained in mailbox.)', approvedBy: 'J. Whitfield', approvedAt: '2026-10-13T10:00:00Z', sentAt: '2026-10-13T10:05:00Z', generator: 'template', validation: { ok: true, issues: [] } },
  ];

  const activity = [
    { at: '2026-08-08T10:00:00Z', actor: 'R. Castellano', type: 'payment_verified', invoiceId: 'INV-2026-1001', message: 'Verified ACH payment PAY-5001 against bank feed.' },
    { at: '2026-09-04T16:20:00Z', actor: 'System', type: 'dispute_opened', invoiceId: 'INV-2026-1007', message: 'Dispute DSP-301 opened from customer email (quantity shortfall).' },
    { at: '2026-09-15T15:20:00Z', actor: 'R. Castellano', type: 'reminder_sent_externally', invoiceId: 'INV-2026-1010', message: 'Approved reminder RMD-701 recorded as sent from staff mailbox.' },
    { at: '2026-09-16T11:00:00Z', actor: 'R. Castellano', type: 'promise_recorded', invoiceId: 'INV-2026-1010', message: 'Promise to pay recorded for 2026-09-30.' },
    { at: '2026-09-18T09:12:00Z', actor: 'System', type: 'info_requested', invoiceId: 'INV-2026-1008', message: 'Customer requested a PO number before processing.' },
    { at: '2026-10-01T08:00:00Z', actor: 'System', type: 'promise_broken', invoiceId: 'INV-2026-1010', message: 'Promise to pay PTP-601 passed without a verified payment.' },
    { at: '2026-10-01T09:00:00Z', actor: 'J. Whitfield', type: 'payment_verified', invoiceId: 'INV-2026-1005', message: 'Verified partial ACH payment PAY-5003 ($3,000.00).' },
    { at: '2026-10-13T10:05:00Z', actor: 'J. Whitfield', type: 'reminder_sent_externally', invoiceId: 'INV-2026-1017', message: 'Approved reminder RMD-702 recorded as sent from staff mailbox.' },
    { at: '2026-10-14T13:40:00Z', actor: 'System', type: 'remittance_received', invoiceId: 'INV-2026-1012', message: 'Remittance advice received for $5,400.00 — awaiting bank confirmation.' },
    { at: '2026-10-16T07:00:00Z', actor: 'Bank feed', type: 'deposit_unapplied', invoiceId: null, message: 'Unapplied ACH deposit PAY-5008 received (QUAYSIDE RETAIL CO 5531).' },
  ];

  const settings = {
    weights: { overdue: 40, balance: 25, dispute: 15, brokenPromise: 10, awaitingInfo: 8, keyAccount: 5, recentContactPenalty: 12 },
    balanceCap: 20000,
    overdueCapDays: 120,
    reminderCooldownDays: 7,
    upcomingWindowDays: 7,
    requestUndisputedPortion: true,
    escalationDays: 45,
    // Locked safeguards — cannot be enabled through the API.
    autoSendReminders: false,
    autoMarkPaid: false,
  };

  return { invoices, payments, disputes, infoRequests, promises, reminders, activity, settings, extractions: [], counters: { reminder: 703, extraction: 1, payment: 5009, invoice: 1023 } };
}

export const sampleDocuments = [
  {
    id: 'SAMPLE-A', label: 'Clean distributor invoice (Tarnby Industrial)', s3Key: 'demo/inbound/tarnby-90155.pdf',
    text: `TARNBY-BOUND SUPPLY CO — INVOICE
Invoice No: INV-2026-1030
Invoice Date: 2026-10-15
Payment Terms: Net 60
Due Date: 2026-12-14
Bill To: Tarnby Industrial Parts
PO Number: TIP-90155

Description                          Qty   Unit Price    Amount
Bearing units, pillow block          80    62.50         5,000.00
Hydraulic fittings assortment (kit)  12    310.00        3,720.00

Subtotal: 8,720.00
Tax: 0.00
Total Due: 8,720.00`,
  },
  {
    id: 'SAMPLE-B', label: 'Agency invoice with missing PO (Halden Creative)', s3Key: 'demo/inbound/halden-oct.pdf',
    text: `INVOICE
Invoice #: INV-2026-1031
Date: 2026-10-10
Terms: Net 30
Bill To: Halden Creative Agency

Description                          Qty   Unit Price    Amount
Motion graphics — holiday cutdowns   1     4,200.00      4,200.00
Voiceover session                    2     350.00        700.00

Subtotal: 4,900.00
Total: 4,900.00`,
  },
  {
    id: 'SAMPLE-C', label: 'Scanned invoice with total mismatch (Vireo Health)', s3Key: 'demo/inbound/vireo-scan.pdf',
    text: `VIREO HEALTH SUPPLIES — STATEMENT / INVOICE
Invoice No: INV-2026-1032
Invoice Date: 2026-10-11
Payment Terms: Net 30
Bill To: Vireo Health Supplies
PO Number: VHS-2290

Description                          Qty   Unit Price    Amount
Exam table paper rolls (case)        40    38.00         1,520.00
Sanitizing wipes (case)              30    44.00         1,320.00
Nitrile gloves (case)                1O    21.50         215.00

Subtotal: 3,055.00
Tax: 183.30
Total Due: 3,328.30`,
  },
];
