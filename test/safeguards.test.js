import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as svc from '../server/service.js';

test('disputed overdue invoice is identified', () => {
  svc.reset();
  const inv = svc.invoiceDetail('INV-2026-1007');
  assert.equal(inv.classification.class, 'disputed');
  assert.ok(inv.classification.flags.includes('overdue'));
  assert.equal(inv.classification.daysOverdue, 38);
  assert.equal(inv.classification.balance, 10158.2);
});

test('dispute-aware draft requests only the undisputed portion and passes validation', async () => {
  svc.reset();
  const d = await svc.createDraft({ invoiceId: 'INV-2026-1007' });
  assert.equal(d.status, 'pending_approval');
  assert.equal(d.tone, 'dispute_aware');
  assert.ok(d.sensitive);
  assert.match(d.body, /\$9,257\.20/);
  assert.ok(d.validation.ok);
});

test('invented amounts block approval', async () => {
  svc.reset();
  const d = await svc.createDraft({ invoiceId: 'INV-2026-1002' });
  svc.editReminder(d.id, { body: d.body + '\nPlease pay $5,000.00 today.' });
  assert.throws(() => svc.approveReminder(d.id, { confirm: true, reviewer: 'Tester' }), /does not match/);
});

test('approval requires confirmation, reviewer and sensitivity acknowledgement', async () => {
  svc.reset();
  const d = await svc.createDraft({ invoiceId: 'INV-2026-1007' });
  assert.throws(() => svc.approveReminder(d.id, {}), /confirmation/);
  assert.throws(() => svc.approveReminder(d.id, { confirm: true, reviewer: 'A' }), /sensitive/);
  const ok = svc.approveReminder(d.id, { confirm: true, reviewer: 'A', acknowledgeSensitive: true });
  assert.equal(ok.status, 'approved');
});

test('invoices cannot be marked paid manually; unconfirmed claims do not reduce balance', () => {
  svc.reset();
  assert.throws(() => svc.markPaidAttempt('INV-2026-1002'), /cannot be marked paid/);
  const inv = svc.invoiceDetail('INV-2026-1012');
  assert.equal(inv.classification.balance, 5400);
  assert.equal(inv.classification.class, 'requires_review');
});

test('verifying a payment requires a bank reference and then derives paid status', () => {
  svc.reset();
  assert.throws(() => svc.verifyPayment('PAY-5006', { confirm: true, reviewer: 'A' }), /Bank transaction reference/);
  const r = svc.verifyPayment('PAY-5006', { confirm: true, reviewer: 'A', bankReference: 'ACH-1' });
  assert.equal(r.invoice.classification.class, 'paid');
});

test('auto-send and auto-paid cannot be enabled', () => {
  svc.reset();
  assert.throws(() => svc.updateSettings({ autoSendReminders: true }), /locked/);
});

test('extraction with total mismatch is blocked from clean creation', async () => {
  svc.reset();
  const x = await svc.runExtraction({ sampleId: 'SAMPLE-C' });
  assert.ok(x.check.issues.some((i) => i.field === 'total' && i.severity === 'block'));
  assert.throws(() => svc.confirmExtraction(x.id, { confirm: true, reviewer: 'A' }), /Blocking/);
});
