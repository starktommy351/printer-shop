// প্রিন্টার লাগানো Windows কম্পিউটারে চালান: node printer-agent.js
// আগে SumatraPDF ইনস্টল করুন এবং নিচের তিনটি সেটিং ঠিক করুন।
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = 'https://your-app.onrender.com';          // আপনার সাইটের URL
const AGENT_KEY = 'ekta-lomba-gopon-key';                // Render-এর AGENT_KEY-র সাথে একই
const SUMATRA = 'C:\\Users\\YOUR_NAME\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe';
const PRINTER = '';                                      // খালি রাখলে ডিফল্ট প্রিন্টার

const H = { 'x-agent-key': AGENT_KEY };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loop() {
  for (;;) {
    try {
      const job = await (await fetch(`${SERVER}/api/agent/next`, { headers: H })).json();
      if (job.id) {
        const buf = Buffer.from(await (await fetch(`${SERVER}/api/agent/file/${job.id}`, { headers: H })).arrayBuffer());
        const file = path.join(os.tmpdir(), `${job.id}.pdf`);
        fs.writeFileSync(file, buf);
        const args = PRINTER ? ['-print-to', PRINTER, '-silent', file] : ['-print-to-default', '-silent', file];
        await new Promise((ok, no) => execFile(SUMATRA, args, e => (e ? no(e) : ok())));
        await fetch(`${SERVER}/api/agent/done/${job.id}`, { method: 'POST', headers: H });
        fs.unlink(file, () => {});
        console.log('প্রিন্ট হয়েছে:', job.id, job.pages, 'পৃষ্ঠা');
        continue;
      }
    } catch (e) { console.log('ত্রুটি:', e.message); }
    await sleep(5000);
  }
}
loop();
