import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as svc from './service.js';
import { MODE } from './aws/adapters.js';

const PORT = Number(process.env.PORT || 4310);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/health', () => ({ ok: true, mode: MODE, asOf: svc.asOf() }));
route('GET', '/api/overview', () => svc.overview());
route('GET', '/api/invoices', (_, q) => svc.listInvoices({ cls: q.get('class'), customer: q.get('customer'), q: q.get('q') }));
route('GET', '/api/invoices/:id', (p) => svc.invoiceDetail(p.id));
route('POST', '/api/invoices/:id/mark-paid', (p) => svc.markPaidAttempt(p.id));
route('GET', '/api/customers', () => svc.listCustomers());
route('GET', '/api/customers/:id', (p) => svc.customerDetail(p.id));
route('GET', '/api/aging', () => svc.aging());
route('GET', '/api/queue', () => svc.followUpQueue());
route('GET', '/api/disputes', () => svc.listDisputes());
route('POST', '/api/disputes/:id/analyze', (p, _, b) => svc.runDisputeAnalysis(p.id, b?.actor));
route('GET', '/api/reminders', (_, q) => svc.listReminders(q.get('status')));
route('POST', '/api/reminders', (_, __, b) => svc.createDraft(b || {}));
route('PATCH', '/api/reminders/:id', (p, _, b) => svc.editReminder(p.id, b || {}));
route('POST', '/api/reminders/:id/approve', (p, _, b) => svc.approveReminder(p.id, b));
route('POST', '/api/reminders/:id/reject', (p, _, b) => svc.rejectReminder(p.id, b));
route('POST', '/api/reminders/:id/mark-sent', (p, _, b) => svc.markReminderSent(p.id, b));
route('GET', '/api/reconciliation', () => svc.reconciliation());
route('POST', '/api/payments/:id/verify', (p, _, b) => svc.verifyPayment(p.id, b));
route('POST', '/api/payments/:id/apply', (p, _, b) => svc.applyPayment(p.id, b));
route('POST', '/api/payments/:id/dismiss', (p, _, b) => svc.rejectPaymentClaim(p.id, b));
route('GET', '/api/extraction/samples', () => svc.listSamples());
route('POST', '/api/extraction', (_, __, b) => svc.runExtraction(b || {}));
route('POST', '/api/extraction/:id/confirm', (p, _, b) => svc.confirmExtraction(p.id, b));
route('GET', '/api/activity', () => svc.listActivity());
route('GET', '/api/reports', () => svc.reports());
route('GET', '/api/settings', () => svc.getSettings());
route('PUT', '/api/settings', (_, __, b) => svc.updateSettings(b || {}));
route('POST', '/api/demo-requests', (_, __, b) => svc.addDemoRequest(b));
route('GET', '/api/marketing/demo-requests', () => svc.listDemoRequests());
route('POST', '/api/demo/reset', () => { svc.reset(); return { ok: true }; });

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new svc.HttpError(413, 'Payload too large');
  }
  if (!data) return null;
  try { return JSON.parse(data); } catch { throw new svc.HttpError(400, 'Invalid JSON'); }
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
        const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        return send(res, 200, await r.handler(params, url.searchParams, body));
      }
      return send(res, 404, { error: 'Not found' });
    }
    let path = url.pathname === '/' ? '/index.html' : url.pathname === '/app' ? '/app.html' : url.pathname;
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    const content = await readFile(file);
    send(res, 200, content, TYPES[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'Not found', 'text/plain');
    if (e instanceof svc.HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Internal error' });
  }
});

server.listen(PORT, () => console.log(`InvoiceHarbor running at http://localhost:${PORT}  (website: /  ·  app: /app  ·  mode: ${MODE})`));
