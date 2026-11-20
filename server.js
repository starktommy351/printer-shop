const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { SP_USERNAME, SP_PASSWORD, SP_PREFIX = 'SP', BASE_URL, AGENT_KEY } = process.env;
const PRICE = Number(process.env.PRICE_PER_PAGE || 10);
const SP = process.env.SP_MODE === 'live'
  ? 'https://engine.shurjopayment.com/api'
  : 'https://sandbox.shurjopayment.com/api';

const DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DIR, { recursive: true });
const upload = multer({ dest: DIR, limits: { fileSize: 20 * 1024 * 1024 } });
const jobs = {}; // id -> {id, file, pages, amount, status, spOrderId}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1) PDF আপলোড ও পৃষ্ঠা গণনা
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ফাইল দিন' });
    const buf = fs.readFileSync(req.file.path);
    if (buf.slice(0, 4).toString() !== '%PDF') {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'শুধু PDF ফাইল দিন' });
    }
    const pages = (await PDFDocument.load(buf, { ignoreEncryption: true })).getPageCount();
    const id = crypto.randomBytes(8).toString('hex');
    jobs[id] = { id, file: req.file.path, pages, amount: pages * PRICE, status: 'uploaded' };
    res.json({ id, pages, amount: pages * PRICE });
  } catch (e) {
    res.status(400).json({ error: 'PDF পড়া যায়নি' });
  }
});

// 2) ShurjoPay পেমেন্ট শুরু
app.post('/api/pay/:id', async (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'uploaded') return res.status(404).json({ error: 'জব পাওয়া যায়নি' });
  try {
    const t = await (await fetch(`${SP}/get_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: SP_USERNAME, password: SP_PASSWORD })
    })).json();
    if (!t.token) throw new Error('token failed');
    const p = await (await fetch(`${SP}/secret-pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `${t.token_type} ${t.token}` },
      body: JSON.stringify({
        prefix: SP_PREFIX, token: t.token, store_id: t.store_id,
        return_url: `${BASE_URL}/api/return`, cancel_url: `${BASE_URL}/?cancelled=1`,
        amount: job.amount, order_id: job.id, currency: 'BDT',
        customer_name: req.body.name || 'Customer',
        customer_phone: req.body.phone || '01700000000',
        customer_address: 'Bangladesh', customer_city: 'Dhaka', customer_post_code: '1200',
        client_ip: req.ip || '127.0.0.1'
      })
    })).json();
    if (!p.checkout_url) throw new Error('checkout failed');
    job.spOrderId = p.sp_order_id;
    res.json({ url: p.checkout_url });
  } catch (e) {
    res.status(500).json({ error: 'পেমেন্ট শুরু করা যায়নি' });
  }
});

// 3) পেমেন্ট শেষে ShurjoPay এখানে ফেরত পাঠায়, আমরা সার্ভার থেকে যাচাই করি
app.get('/api/return', async (req, res) => {
  try {
    const t = await (await fetch(`${SP}/get_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: SP_USERNAME, password: SP_PASSWORD })
    })).json();
    const v = await (await fetch(`${SP}/verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `${t.token_type} ${t.token}` },
      body: JSON.stringify({ order_id: req.query.order_id })
    })).json();
    const r = Array.isArray(v) ? v[0] : v;
    const job = r && jobs[r.customer_order_id];
    if (job && Number(r.sp_code) === 1000 && job.status === 'uploaded') {
      job.status = 'paid';
      return res.redirect(`/?done=${job.id}`);
    }
  } catch (e) {}
  res.redirect('/?failed=1');
});

app.get('/api/status/:id', (req, res) => {
  const j = jobs[req.params.id];
  res.json({ status: j ? j.status : 'none' });
});

// 4) প্রিন্টার এজেন্টের জন্য (গোপন কী লাগবে)
const agent = (req, res, next) =>
  AGENT_KEY && req.get('x-agent-key') === AGENT_KEY ? next() : res.status(401).end();

app.get('/api/agent/next', agent, (req, res) => {
  const j = Object.values(jobs).find(x => x.status === 'paid');
  if (!j) return res.json({});
  j.status = 'printing';
  res.json({ id: j.id, pages: j.pages });
});
app.get('/api/agent/file/:id', agent, (req, res) => {
  const j = jobs[req.params.id];
  j ? res.sendFile(j.file) : res.status(404).end();
});
app.post('/api/agent/done/:id', agent, (req, res) => {
  const j = jobs[req.params.id];
  if (j) { j.status = 'printed'; fs.unlink(j.file, () => {}); }
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
