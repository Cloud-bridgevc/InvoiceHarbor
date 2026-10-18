// Scheduled AWS Lambda tasks (triggered by EventBridge Scheduler — see infra/template.yaml).
// None of these handlers send messages, change balances, or move money.
// Each one only reads recorded data and writes snapshots, flags, or drafts for review.
//
// For local runs without DATABASE_URL they use the demo seed:  node lambda/scheduled.js nightlyAging

import { buildSeed, customers } from '../server/data/seed.js';
import { classify, prioritize } from '../server/engine/core.js';

const today = () => process.env.DEMO_AS_OF || new Date().toISOString().slice(0, 10);

async function loadTenant() {
  if (!process.env.DATABASE_URL) return { ...buildSeed(), customers };
  // Production: load tenant records from PostgreSQL (ar schema) via `pg` and set app.tenant_id for RLS.
  throw new Error('PostgreSQL loader is not wired up in the demo build.');
}

/** 02:00 daily: recompute classification + priority for every open invoice and store snapshots. */
export async function nightlyAging() {
  const db = await loadTenant();
  const asOf = today();
  const snapshots = db.invoices.map((inv) => {
    const c = classify(inv, db, asOf);
    const p = prioritize(inv, c, db, asOf);
    return { invoiceId: inv.id, asOf, class: c.class, flags: c.flags, daysOverdue: c.daysOverdue, balance: c.balance, priority: p?.score ?? null };
  });
  // Production: INSERT INTO ar.classification_snapshots ... ON CONFLICT DO NOTHING
  return { asOf, count: snapshots.length, snapshots };
}

/** 07:00 weekdays: mark promises to pay as broken when no verified payment arrived by the promised date. */
export async function promiseMonitor() {
  const db = await loadTenant();
  const asOf = today();
  const broken = db.promises.filter((p) => p.status === 'open' && p.promisedDate < asOf).filter((p) => {
    const inv = db.invoices.find((i) => i.id === p.invoiceId);
    return classify(inv, db, asOf).balance > 0;
  });
  // Production: UPDATE promises_to_pay SET status='broken' and write to activity_log.
  return { asOf, broken: broken.map((p) => p.id) };
}

/** 08:00 weekdays: list disputes where the customer is waiting on us beyond the SLA. Flags only, no messages. */
export async function disputeSla({ slaDays = 5 } = {}) {
  const db = await loadTenant();
  const asOf = today();
  const overdue = db.disputes.filter((d) => d.status === 'open').filter((d) => {
    const last = d.messages.at(-1);
    return last?.from === 'customer' && (new Date(asOf) - new Date(last.date)) / 86400000 > slaDays;
  });
  return { asOf, slaDays, needsResponse: overdue.map((d) => ({ disputeId: d.id, invoiceId: d.invoiceId, owner: d.owner })) };
}

/** 06:00 Mondays: weekly receivables report snapshot (stored in S3 as JSON for the reporting UI). */
export async function weeklyReport() {
  const { snapshots, asOf } = await nightlyAging();
  const open = snapshots.filter((s) => s.class !== 'paid');
  return { asOf, outstanding: open.reduce((s, x) => s + x.balance, 0), overdue: open.filter((x) => x.daysOverdue > 0).reduce((s, x) => s + x.balance, 0) };
}

if (process.argv[1]?.endsWith('scheduled.js')) {
  const fn = { nightlyAging, promiseMonitor, disputeSla, weeklyReport }[process.argv[2] || 'nightlyAging'];
  fn().then((r) => console.log(JSON.stringify(r, null, 2)));
}
