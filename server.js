const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { SSL_STORE_ID, SSL_STORE_PASS, BASE_URL, AGENT_KEY } = process.env;
const PRICE = Number(process.env.PRICE_PER_PAGE || 10);
const SSL = process.env.SSL_MODE === 'live'
  ? 'https://securepay.sslcommerz.com'
  : 'https://sandbox.sslcommerz.com';

const DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DIR, { recursive: true });
const upload = multer({ dest: DIR, limits: { fileSize: 20 * 1024 * 1024 } });
const jobs = {}; // id -> {id, file, pages, amount, status}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// 2) SSLCommerz পেমেন্ট শুরু
app.post('/api/pay/:id', async (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'uploaded') return res.status(404).json({ error: 'জব পাওয়া যায়নি' });
  try {
    const body = new URLSearchParams({
      store_id: SSL_STORE_ID,
      store_passwd: SSL_STORE_PASS,
      total_amount: String(job.amount),
      currency: 'BDT',
      tran_id: job.id,
      success_url: `${BASE_URL}/api/success`,
      fail_url: `${BASE_URL}/api/fail`,
      cancel_url: `${BASE_URL}/api/cancel`,
      cus_name: req.body.name || 'Customer',
      cus_email: 'customer@example.com',
      cus_add1: 'Bangladesh',
      cus_city: 'Dhaka',
      cus_country: 'Bangladesh',
      cus_phone: req.body.phone || '01700000000',
      shipping_method: 'NO',
      product_name: 'PDF Print',
      product_category: 'Service',
      product_profile: 'general'
    });
    const r = await (await fetch(`${SSL}/gwprocess/v4/api.php`, { method: 'POST', body })).json();
    if (!r.GatewayPageURL) throw new Error(r.failedreason || 'no url');
    res.json({ url: r.GatewayPageURL });
  } catch (e) {
    res.status(500).json({ error: 'পেমেন্ট শুরু করা যায়নি' });
  }
});

// 3) পেমেন্ট শেষে SSLCommerz এখানে POST করে, আমরা সার্ভার থেকে যাচাই করি
app.post('/api/success', async (req, res) => {
  try {
    const { val_id } = req.body;
    const url = `${SSL}/validator/api/validationserverAPI.php?val_id=${encodeURIComponent(val_id)}` +
      `&store_id=${encodeURIComponent(SSL_STORE_ID)}&store_passwd=${encodeURIComponent(SSL_STORE_PASS)}&format=json`;
    const v = await (await fetch(url)).json();
    const job = jobs[v.tran_id];
    const ok = v.status === 'VALID' || v.status === 'VALIDATED';
    if (job && ok && parseFloat(v.amount) >= job.amount) {
      if (job.status === 'uploaded') job.status = 'paid';
      return res.redirect(303, `/?done=${job.id}`);
    }
  } catch (e) {}
  res.redirect(303, '/?failed=1');
});
app.post('/api/fail', (req, res) => res.redirect(303, '/?failed=1'));
app.post('/api/cancel', (req, res) => res.redirect(303, '/?cancelled=1'));

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
