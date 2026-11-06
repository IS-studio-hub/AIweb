// FARQ – web server (zero dependencies: needs only Node.js 20+)
//
//  Shop (public)
//   POST /api/chat        shopper message → streamed NDJSON (text + product cards + bag + checkout events)
//   POST /api/voice       recorded question → transcript + spoken answer (+ the same events)
//   GET  /api/store       public store info          GET/POST /api/cart     bag
//   POST /api/checkout    place order (pay later or Stripe card)
//   POST /api/order/confirm   confirm Stripe payment after redirect
//   POST /api/call        lead form → outbound AI phone call (Twilio)
//   WS   /media-stream    live call audio ⇄ OpenAI Realtime
//  Admin (password-protected, UI at /admin)
//   /api/admin/*          orders, fulfillment, products, uploads, settings, prompt, leads
//
// Keys live only in .env and are never sent to the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- .env (loaded before the modules read it)
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();
const env = (k, d) => (process.env[k] ?? '').trim() || d;

const { runTurn, cleanHistory, phoneBriefing } = await import('./lib/assistant.js');
const { AIError, aiConfig } = await import('./lib/ai.js');
const C = await import('./lib/commerce.js');
const catalog = await import('./lib/catalog.js');
const K = await import('./lib/knowledge.js');
const { DATA_DIR, uid } = await import('./lib/db.js');

const PORT = Number(env('PORT', 3000));
const OPENAI_API_KEY = env('OPENAI_API_KEY');
const OA = env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, '');
const STT_MODEL = env('OPENAI_STT_MODEL', 'gpt-4o-mini-transcribe');
const TTS_MODEL = env('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts');
const TTS_VOICE = env('OPENAI_TTS_VOICE', 'ash');
const REALTIME_MODEL = env('OPENAI_REALTIME_MODEL', 'gpt-realtime');
const REALTIME_VOICE = env('OPENAI_REALTIME_VOICE', 'ash');
const PUBLIC_URL = env('PUBLIC_URL', '').replace(/\/$/, '');
const TWILIO_ACCOUNT_SID = env('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = env('TWILIO_AUTH_TOKEN');
const TWILIO_FROM_NUMBER = env('TWILIO_FROM_NUMBER');
const TWILIO_API = env('TWILIO_API_BASE', 'https://api.twilio.com');

if (!aiConfig().key) console.warn('⚠️  No AI key – set OPENAI_API_KEY (or AI_API_KEY) in .env');

// Admin password: ADMIN_PASSWORD in .env, otherwise one is generated once and stored in data/admin-password.txt
const ADMIN_PASSWORD = (() => {
  if (env('ADMIN_PASSWORD')) return env('ADMIN_PASSWORD');
  const f = path.join(DATA_DIR, 'admin-password.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const p = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(f, p + '\n', { mode: 0o600 });
  return p;
})();

const oaHeaders = (json = true) => ({ Authorization: `Bearer ${OPENAI_API_KEY}`, ...(json ? { 'Content-Type': 'application/json' } : {}) });

// ---------------------------------------------------------------- HTTP helpers
const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const httpError = (status, message) => Object.assign(new Error(message), { status });
function readJson(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(httpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(httpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}
const clientIp = (req) => (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '';
const originOf = (req) => PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
const validSid = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);

// ---------------------------------------------------------------- static files
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.fbx': 'application/octet-stream', '.glb': 'model/gltf-binary', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'Bad path' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) { res.writeHead(301, { Location: pathname + '/' }); return res.end(); }
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- rate limiter
const buckets = new Map();
function limited(name, req, max, windowMs) {
  const key = `${name}:${clientIp(req)}`;
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n++;
  buckets.set(key, b);
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60_000).unref();

// ---------------------------------------------------------------- shop API
function storeInfo() {
  const s = C.settings();
  return {
    storeName: (process.env.BRAND_NAME || '').trim() || s.storeName,
    knowledgeOnly: (process.env.KNOWLEDGE_ONLY || '').trim().toLowerCase() === 'true', assistantName: s.assistantName, currency: s.currency,
    remoteCatalog: catalog.usingRemoteCatalog(), externalCheckout: !!catalog.shopifyOrigin(),
    flatShipping: s.flatShipping, freeShippingOver: s.freeShippingOver, taxRate: s.taxRate,
    payments: { card: C.stripeEnabled(), payLater: s.payOnDelivery !== false || !C.stripeEnabled() },
  };
}

async function handleChat(req, res) {
  if (limited('chat', req, 40, 60_000)) return sendJson(res, 429, { error: 'Too many messages – please wait a moment.' });
  const body = await readJson(req);
  if (!validSid(body.sid)) return sendJson(res, 400, { error: 'Missing session.' });
  const history = cleanHistory(body.messages);
  if (!history.length) return sendJson(res, 400, { error: 'Please type a question.' });

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const emit = (ev) => res.write(JSON.stringify(ev) + '\n');
  try {
    await runTurn({ sid: body.sid, history, mode: 'text', emit });
  } catch (e) {
    if (!(e instanceof AIError)) console.error(e);
    emit({ t: 'error', message: e instanceof AIError ? e.message : 'Something went wrong – please try again.' });
  }
  emit({ t: 'done' });
  res.end();
}

async function handleVoice(req, res) {
  if (limited('voice', req, 20, 60_000)) return sendJson(res, 429, { error: 'Too many requests – please wait a moment.' });
  const body = await readJson(req);
  if (!validSid(body.sid)) return sendJson(res, 400, { error: 'Missing session.' });
  const { audio, mimeType = 'audio/webm' } = body;
  if (!audio || typeof audio !== 'string') return sendJson(res, 400, { error: 'No audio received.' });
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length < 1000) return sendJson(res, 400, { error: 'I could not hear anything – please try again.' });

  // 1) speech → text
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
  const transcribe = (model) => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: mimeType.split(';')[0] }), `question.${ext}`);
    fd.append('model', model);
    return fetch(`${OA}/audio/transcriptions`, { method: 'POST', headers: oaHeaders(false), body: fd });
  };
  let tr = await transcribe(STT_MODEL);
  if (!tr.ok && tr.status !== 401) tr = await transcribe('whisper-1');
  if (!tr.ok) throw httpError(502, tr.status === 401 ? 'The AI service rejected the API key.' : 'Speech recognition is unavailable right now.');
  const transcript = ((await tr.json()).text || '').trim();
  if (!transcript) return sendJson(res, 422, { error: 'I could not make out the question – please try again.' });

  // 2) the sales associate answers (tools may show products / update the bag)
  const events = [];
  let reply;
  try {
    reply = await runTurn({
      sid: body.sid, history: [...cleanHistory(body.messages), { role: 'user', content: transcript }], mode: 'voice',
      emit: (ev) => { if (ev.t !== 'text') events.push(ev); },
    });
  } catch (e) {
    throw httpError(502, e instanceof AIError ? e.message : 'Something went wrong – please try again.');
  }

  // 3) text → speech
  const speak = (model) => fetch(`${OA}/audio/speech`, {
    method: 'POST', headers: oaHeaders(),
    body: JSON.stringify({
      model, voice: TTS_VOICE, input: reply || 'Sorry, could you say that again?', response_format: 'mp3',
      ...(model.startsWith('gpt-') ? { instructions: 'Friendly, upbeat sales associate in a clothing store. Natural, warm, confident; conversational pace.' } : {}),
    }),
  });
  let sr = await speak(TTS_MODEL);
  if (!sr.ok && sr.status !== 401) sr = await speak('tts-1');
  if (!sr.ok) throw httpError(502, 'Text-to-speech is unavailable right now.');
  const mp3 = Buffer.from(await sr.arrayBuffer());
  sendJson(res, 200, { transcript, reply, events, audio: mp3.toString('base64'), audioType: 'audio/mpeg' });
}

async function handleCart(req, res, method) {
  if (method === 'GET') {
    const sid = new URL(req.url, 'http://x').searchParams.get('sid');
    if (!validSid(sid)) return sendJson(res, 400, { error: 'Missing session.' });
    return sendJson(res, 200, { cart: await C.cartView(sid) });
  }
  if (limited('cart', req, 120, 60_000)) return sendJson(res, 429, { error: 'Too many requests.' });
  const b = await readJson(req, 64 * 1024);
  if (!validSid(b.sid)) return sendJson(res, 400, { error: 'Missing session.' });
  if (b.action === 'add') {
    const r = await C.addToCart(b.sid, { productId: b.productId, size: b.size, color: b.color, qty: b.qty || 1 });
    return sendJson(res, r.ok ? 200 : 400, r.ok ? { cart: r.cart, limited: r.limited } : { error: r.error });
  }
  if (b.action === 'update') return sendJson(res, 200, { cart: await C.updateCartLine(b.sid, String(b.lineId), Number(b.qty)) });
  return sendJson(res, 400, { error: 'Unknown action.' });
}

async function handleCheckout(req, res) {
  if (limited('checkout', req, 10, 10 * 60_000)) return sendJson(res, 429, { error: 'Too many attempts – please wait a few minutes.' });
  const b = await readJson(req, 64 * 1024);
  if (!validSid(b.sid)) return sendJson(res, 400, { error: 'Missing session.' });
  const { customer, address, errors } = C.validateCheckout(b);
  if (errors.length) return sendJson(res, 400, { error: `Please check: ${errors.join(', ')}.`, fields: errors });
  const info = storeInfo();
  const method = b.paymentMethod === 'card' && info.payments.card ? 'card' : 'pay_later';
  if (method === 'pay_later' && !info.payments.payLater) return sendJson(res, 400, { error: 'Please pay by card.' });
  const r = await C.createOrder(b.sid, { customer, address, paymentMethod: method, note: b.note });
  if (!r.ok) return sendJson(res, 400, { error: r.error });
  console.log(`[order] ${r.order.id} – ${r.order.customer.name} – ${C.money(r.order.total)} (${method})`);
  if (method === 'card') {
    try {
      const url = await C.createStripeSession(r.order, originOf(req));
      return sendJson(res, 200, { order: C.publicOrder(r.order), token: r.order.token, redirectUrl: url });
    } catch (e) {
      console.error('[stripe]', e.message);
      C.updateOrder(r.order.id, { internalNote: `Stripe error: ${e.message}` });
      return sendJson(res, 200, { order: C.publicOrder(r.order), token: r.order.token, warning: 'Card payment could not be started – your order is saved and we will contact you to complete payment.' });
    }
  }
  sendJson(res, 200, { order: C.publicOrder(r.order), token: r.order.token });
}

async function handleConfirm(req, res) {
  const b = await readJson(req, 16 * 1024);
  const o = await C.confirmStripe(String(b.orderId || ''), String(b.token || ''), String(b.sessionId || ''));
  if (!o) return sendJson(res, 404, { error: 'Order not found.' });
  sendJson(res, 200, { order: C.publicOrder(o) });
}

// ---------------------------------------------------------------- phone call request (Twilio)
const pendingCalls = new Map();
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

async function handleCall(req, res) {
  if (limited('call', req, 3, 10 * 60_000)) return sendJson(res, 429, { error: 'Too many call requests – please try again in a few minutes.' });
  const b = await readJson(req, 64 * 1024);
  const lead = {
    firstName: String(b.firstName ?? '').trim().slice(0, 60),
    lastName: String(b.lastName ?? '').trim().slice(0, 60),
    email: String(b.email ?? '').trim().slice(0, 120),
    phone: String(b.phone ?? '').replace(/[^\d+]/g, ''),
  };
  if (!lead.firstName || !lead.lastName) return sendJson(res, 400, { error: 'Please enter your first and last name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return sendJson(res, 400, { error: 'Please enter a valid email.' });
  if (!/^\+[1-9]\d{7,14}$/.test(lead.phone)) return sendJson(res, 400, { error: 'Please enter your phone number with country code, e.g. +1 416 555 0123.' });

  fs.appendFileSync(path.join(DATA_DIR, 'leads.jsonl'), JSON.stringify({ ...lead, at: new Date().toISOString(), ip: clientIp(req) }) + '\n');

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !PUBLIC_URL) {
    console.warn('[call] Twilio/PUBLIC_URL not configured – lead saved, no call placed.');
    return sendJson(res, 503, { error: 'Phone calls are not set up yet. We saved your details and will reach out soon.' });
  }
  const token = crypto.randomUUID();
  pendingCalls.set(token, { lead });
  setTimeout(() => pendingCalls.delete(token), 10 * 60_000).unref();
  const wsUrl = PUBLIC_URL.replace(/^http/, 'ws') + '/media-stream';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(wsUrl)}"><Parameter name="token" value="${xml(token)}"/></Stream></Connect></Response>`;
  let r, j;
  try {
    r = await fetch(`${TWILIO_API}/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: lead.phone, From: TWILIO_FROM_NUMBER, Twiml: twiml }),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    console.error('[twilio]', e.message);
    return sendJson(res, 502, { error: 'We couldn’t reach the phone service.' });
  }
  if (!r.ok) {
    console.error('[twilio]', r.status, j.message || j);
    return sendJson(res, 502, { error: j.code === 21219 || j.code === 21608 ? 'This number can’t be called from our trial line yet.' : 'We couldn’t place the call. Please check the number and try again.' });
  }
  console.log(`[call] dialing ${lead.phone} (${j.sid})`);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------- admin API
const adminSessions = new Map(); // token → expiry
const PROMPT_FILE = path.join(__dirname, 'config', 'assistant-prompt.md');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');

function isAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = adminSessions.get(t);
  if (!exp || exp < Date.now()) { adminSessions.delete(t); return false; }
  return true;
}
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function cleanProduct(b, existing = {}) {
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  const sizes = list(b.sizes), colors = list(b.colors);
  const prevStock = new Map((existing.variants || []).map((v) => [`${v.color || ''}|${v.size || ''}`, v]));
  const given = new Map((Array.isArray(b.variants) ? b.variants : []).map((v) => [`${v.color || ''}|${v.size || ''}`, v]));
  const combos = (colors.length ? colors : [null]).flatMap((c) => (sizes.length ? sizes : [null]).map((s) => [c, s]));
  const variants = combos.map(([c, s]) => {
    const key = `${c || ''}|${s || ''}`;
    const g = given.get(key), p = prevStock.get(key);
    return { id: p?.id || g?.id || uid('v_'), color: c, size: s, stock: Math.max(0, Math.floor(num(g?.stock ?? p?.stock, 0))) };
  });
  return {
    id: existing.id || String(b.id || '').trim().replace(/[^\w-]/g, '-').slice(0, 80) || uid('p_'),
    name: String(b.name || '').trim().slice(0, 140) || 'Untitled product',
    category: String(b.category || '').trim().slice(0, 60),
    description: String(b.description || '').slice(0, 4000),
    highlights: list(b.highlights).slice(0, 10),
    tags: list(b.tags).slice(0, 30),
    price: Math.max(0, num(b.price)),
    compareAtPrice: b.compareAtPrice ? Math.max(0, num(b.compareAtPrice)) : null,
    images: list(b.images).slice(0, 10),
    colors, sizes, variants,
    active: b.active !== false,
    sample: false,
    priceNote: String(b.priceNote ?? existing.priceNote ?? '').slice(0, 120),
    notForSale: typeof b.notForSale === 'boolean' ? b.notForSale : !!existing.notForSale,
    availableIn: Array.isArray(b.availableIn) ? b.availableIn.map(String) : (existing.availableIn || []),
    includes: Array.isArray(b.includes) ? b.includes.map(String) : (existing.includes || []),
  };
}

async function handleAdmin(req, res, pathname, method) {
  if (pathname === '/api/admin/login' && method === 'POST') {
    if (limited('login', req, 8, 15 * 60_000)) return sendJson(res, 429, { error: 'Too many attempts – try again later.' });
    const b = await readJson(req, 4096);
    if (!safeEq(b.password || '', ADMIN_PASSWORD)) return sendJson(res, 401, { error: 'Wrong password.' });
    const t = crypto.randomBytes(24).toString('hex');
    adminSessions.set(t, Date.now() + 12 * 3600e3);
    return sendJson(res, 200, { token: t });
  }
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Please sign in.' });

  const parts = pathname.split('/').slice(3); // after /api/admin
  const [section, id] = parts;

  if (section === 'summary') return sendJson(res, 200, await C.salesSummary());

  if (section === 'orders') {
    if (!id && method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const status = q.get('status'), search = (q.get('q') || '').toLowerCase();
      let list = C.ordersStore.get().orders;
      if (status && status !== 'all') list = list.filter((o) => o.status === status);
      if (search) list = list.filter((o) => [o.id, o.customer.name, o.customer.email, o.customer.phone].join(' ').toLowerCase().includes(search));
      return sendJson(res, 200, { orders: list.slice(0, 500) });
    }
    const o = C.getOrder(decodeURIComponent(id || ''));
    if (!o) return sendJson(res, 404, { error: 'Order not found.' });
    if (method === 'GET') return sendJson(res, 200, { order: o });
    if (method === 'PATCH') return sendJson(res, 200, { order: C.updateOrder(o.id, await readJson(req, 64 * 1024)) });
  }

  if (section === 'products') {
    if (catalog.usingRemoteCatalog() && method !== 'GET') return sendJson(res, 400, { error: 'Products come from CATALOG_API_URL – edit them in your API.' });
    if (!id && method === 'GET') return sendJson(res, 200, { products: await catalog.allProducts({ includeInactive: true }), remote: catalog.usingRemoteCatalog() });
    if (id === 'import' && method === 'POST') {
      const b = await readJson(req, 8 * 1024 * 1024);
      const incoming = (Array.isArray(b.products) ? b.products : []).slice(0, 2000).map((p) => cleanProduct(p));
      if (!incoming.length) return sendJson(res, 400, { error: 'No products found in the file.' });
      let added = 0, updated = 0, removed = 0;
      catalog.catalogStore.update((list) => {
        if (b.removeSamples) { const before = list.length; for (let i = list.length - 1; i >= 0; i--) if (list[i].sample) list.splice(i, 1); removed = before - list.length; }
        for (const p of incoming) {
          const i = list.findIndex((x) => String(x.id) === p.id || x.name.toLowerCase() === p.name.toLowerCase());
          if (i >= 0) { list[i] = { ...p, id: list[i].id }; updated++; } else { list.push(p); added++; }
        }
      });
      return sendJson(res, 200, { added, updated, removed });
    }
    if (!id && method === 'POST') {
      const p = cleanProduct(await readJson(req, 256 * 1024));
      catalog.catalogStore.update((list) => { list.unshift(p); });
      return sendJson(res, 200, { product: p });
    }
    const list = catalog.catalogStore.get();
    const idx = list.findIndex((p) => String(p.id) === decodeURIComponent(id || ''));
    if (idx < 0) return sendJson(res, 404, { error: 'Product not found.' });
    if (method === 'PUT') {
      const p = cleanProduct(await readJson(req, 256 * 1024), list[idx]);
      catalog.catalogStore.update((l) => { l[idx] = p; });
      return sendJson(res, 200, { product: p });
    }
    if (method === 'DELETE') {
      catalog.catalogStore.update((l) => { l.splice(idx, 1); });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (section === 'upload' && method === 'POST') {
    const b = await readJson(req, 12 * 1024 * 1024);
    const m = String(b.data || '').match(/^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/);
    if (!m) return sendJson(res, 400, { error: 'Please upload a PNG, JPG, WEBP or GIF image.' });
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 8 * 1024 * 1024) return sendJson(res, 413, { error: 'Image is larger than 8 MB.' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `${uid()}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return sendJson(res, 200, { url: `/uploads/${name}` });
  }

  if (section === 'settings') {
    if (method === 'GET') return sendJson(res, 200, { settings: C.settings(), stripe: C.stripeEnabled(), ai: { base: aiConfig().base, model: aiConfig().model }, remoteCatalog: catalog.usingRemoteCatalog() });
    if (method === 'PUT') {
      const b = await readJson(req, 64 * 1024);
      const s = C.settingsStore.update((cur) => {
        for (const k of ['storeName', 'assistantName', 'currency', 'about', 'policies', 'contact']) if (typeof b[k] === 'string') cur[k] = b[k].slice(0, 6000);
        for (const k of ['flatShipping', 'freeShippingOver', 'taxRate']) if (Number.isFinite(+b[k])) cur[k] = Math.max(0, +b[k]);
        if (typeof b.payOnDelivery === 'boolean') cur.payOnDelivery = b.payOnDelivery;
        cur.currency = /^[A-Z]{3}$/.test(cur.currency) ? cur.currency : 'USD';
        return cur;
      });
      return sendJson(res, 200, { settings: s });
    }
  }

  if (section === 'prompt') {
    if (method === 'GET') return sendJson(res, 200, { prompt: fs.readFileSync(PROMPT_FILE, 'utf8') });
    if (method === 'PUT') {
      const b = await readJson(req, 128 * 1024);
      if (typeof b.prompt !== 'string' || b.prompt.trim().length < 20) return sendJson(res, 400, { error: 'Prompt is too short.' });
      fs.writeFileSync(PROMPT_FILE, b.prompt);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (section === 'knowledge') {
    if (method === 'GET') return sendJson(res, 200, K.knowledgeStats());
    if (method === 'POST') {
      const b = await readJson(req, 16 * 1024);
      const r = await K.askKnowledge(b.question || 'What does FARQ sell?', { timeoutMs: Math.min(180000, Number(b.timeoutMs) || 60000), useCache: false, force: true });
      return sendJson(res, 200, { ...r, stats: K.knowledgeStats() });
    }
  }

  if (section === 'leads' && method === 'GET') {
    const f = path.join(DATA_DIR, 'leads.jsonl');
    const leads = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse() : [];
    return sendJson(res, 200, { leads: leads.slice(0, 300) });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const method = req.method;
  try {
    if (pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, pathname, method);
    if (pathname.startsWith('/api/')) {
      if (method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, ai: !!aiConfig().key, knowledge: K.knowledgeEnabled(), phone: !!(TWILIO_ACCOUNT_SID && PUBLIC_URL), card: C.stripeEnabled() });
      if (method === 'GET' && pathname === '/api/store') return sendJson(res, 200, storeInfo());
      if (pathname === '/api/cart' && (method === 'GET' || method === 'POST')) return await handleCart(req, res, method);
      if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      if (pathname === '/api/chat') return await handleChat(req, res);
      if (pathname === '/api/voice') return await handleVoice(req, res);
      if (pathname === '/api/checkout') return await handleCheckout(req, res);
      if (pathname === '/api/order/confirm') return await handleConfirm(req, res);
      if (pathname === '/api/checkout-url') {
        const b = await readJson(req, 4096);
        if (!validSid(b.sid)) return sendJson(res, 400, { error: 'Missing session.' });
        const url = await C.externalCheckoutUrl(b.sid);
        return url ? sendJson(res, 200, { url }) : sendJson(res, 400, { error: 'Your bag is empty.' });
      }
      if (pathname === '/api/call') return await handleCall(req, res);
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    serveStatic(req, res, pathname);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
    else res.end();
  }
});

// ---------------------------------------------------------------- minimal WebSocket server (RFC 6455)
class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.onmessage = () => {};
    this.onclose = () => {};
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }
  closed() { if (this.open) { this.open = false; this.onclose(); } }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskOff + (i & 3)];
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      this.frag.push(payload);
      if (fin) { const msg = Buffer.concat(this.frag); this.frag = []; this.onmessage(msg.toString('utf8')); }
    }
  }
  frame(op, data) {
    if (!this.open) return;
    const n = data.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) head = Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.socket.write(Buffer.concat([head, data]));
  }
  send(str) { this.frame(0x1, Buffer.from(str, 'utf8')); }
  close() {
    if (!this.open) return;
    try { this.frame(0x8, Buffer.alloc(0)); } catch {}
    this.open = false;
    this.socket.end();
    this.onclose();
  }
}

server.on('upgrade', (req, socket) => {
  const { pathname } = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (pathname !== '/media-stream' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  bridgeCall(new WSConn(socket));
});

// ---------------------------------------------------------------- live call bridge: Twilio ⇄ OpenAI Realtime
function bridgeCall(twilio) {
  let streamSid = null, lead = null;
  let latestMediaTs = 0, responseStartTs = null, lastAssistantItem = null;
  const markQueue = [];
  const sendTw = (obj) => twilio.send(JSON.stringify(obj));
  const rtUrl = OA.replace(/^http/, 'ws') + `/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const openai = new WebSocket(rtUrl, ['realtime', `openai-insecure-api-key.${OPENAI_API_KEY}`]);
  const sendOA = (obj) => openai.readyState === WebSocket.OPEN && openai.send(JSON.stringify(obj));

  let started = false;
  const startConversation = async () => {
    if (started || openai.readyState !== WebSocket.OPEN || !streamSid) return;
    started = true;
    const s = C.settings();
    const who = lead ? `${lead.firstName} ${lead.lastName}`.trim() : 'the caller';
    const base = (process.env.KNOWLEDGE_ONLY || '').trim().toLowerCase() === 'true' ? '' : fs.readFileSync(PROMPT_FILE, 'utf8').replaceAll('{{assistantName}}', s.assistantName).replaceAll('{{storeName}}', s.storeName);
    sendOA({
      type: 'session.update',
      session: {
        type: 'realtime', model: REALTIME_MODEL, output_modalities: ['audio'],
        instructions: base + (await phoneBriefing()) + `\n\nYou are on a live phone call with ${who}${lead?.email ? ` (email: ${lead.email})` : ''}, who requested a call from the website. Speak naturally and briefly like a friendly human on the phone (1–3 sentences at a time), let them interrupt, and ask a short follow-up question when helpful. Never read out URLs or long numbers unless asked.${K.knowledgeEnabled() ? ' For FARQ facts that are not in the store facts above, call ask_farq_knowledge (say something natural like "one sec, let me check" first).' : ''}`,
        audio: {
          input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad', silence_duration_ms: 500, prefix_padding_ms: 300 } },
          output: { format: { type: 'audio/pcmu' }, voice: REALTIME_VOICE },
        },
        ...(K.knowledgeEnabled() ? {
          tools: [{ type: 'function', name: 'ask_farq_knowledge', description: K.KNOWLEDGE_TOOL_DESCRIPTION, parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } }],
          tool_choice: 'auto',
        } : {}),
      },
    });
    sendOA({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(The call just connected. Greet ${lead?.firstName || 'them'} by first name, say you're ${s.assistantName} from ${(process.env.BRAND_NAME || "").trim() || s.storeName} calling because they asked for a call on the website, and ask how you can help.)` }] },
    });
    sendOA({ type: 'response.create' });
  };

  openai.addEventListener('open', startConversation);
  openai.addEventListener('message', (e) => {
    let ev;
    try { ev = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString()); } catch { return; }
    switch (ev.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (!streamSid) break;
        sendTw({ event: 'media', streamSid, media: { payload: ev.delta } });
        if (responseStartTs === null) responseStartTs = latestMediaTs;
        if (ev.item_id) lastAssistantItem = ev.item_id;
        sendTw({ event: 'mark', streamSid, mark: { name: 'r' } });
        markQueue.push('r');
        break;
      }
      case 'input_audio_buffer.speech_started':
        if (markQueue.length && responseStartTs !== null && lastAssistantItem) {
          sendOA({ type: 'conversation.item.truncate', item_id: lastAssistantItem, content_index: 0, audio_end_ms: Math.max(0, latestMediaTs - responseStartTs) });
          sendTw({ event: 'clear', streamSid });
          markQueue.length = 0; lastAssistantItem = null; responseStartTs = null;
        }
        break;
      case 'response.function_call_arguments.done': {
        if (ev.name !== 'ask_farq_knowledge') break;
        let args = {};
        try { args = JSON.parse(ev.arguments || '{}'); } catch {}
        K.askKnowledge(args.question, { timeoutMs: 12000 }).then((r) => {
          sendOA({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(r.ok ? { answer: r.answer } : { unavailable: true, note: 'Answer from the store facts only, or offer to have the team follow up by email.' }) } });
          sendOA({ type: 'response.create' });
        });
        break;
      }
      case 'error':
        console.error('[realtime]', ev.error?.message || ev);
        break;
    }
  });
  openai.addEventListener('error', (e) => console.error('[realtime ws]', e.message || 'connection error'));
  openai.addEventListener('close', () => twilio.close());

  twilio.onmessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.event) {
      case 'start': {
        streamSid = msg.start.streamSid;
        const token = msg.start.customParameters?.token;
        lead = pendingCalls.get(token)?.lead || null;
        pendingCalls.delete(token);
        if (!lead) { console.warn('[call] unknown stream token – closing'); twilio.close(); return; }
        console.log(`[call] connected with ${lead.firstName} ${lead.lastName}`);
        startConversation();
        break;
      }
      case 'media':
        latestMediaTs = Number(msg.media.timestamp) || latestMediaTs;
        sendOA({ type: 'input_audio_buffer.append', audio: msg.media.payload });
        break;
      case 'mark': markQueue.shift(); break;
      case 'stop': openai.close(); break;
    }
  };
  twilio.onclose = () => {
    if (openai.readyState === WebSocket.OPEN || openai.readyState === WebSocket.CONNECTING) openai.close();
  };
}

server.listen(PORT, () => {
  console.log(`\n  FARQ is running →  http://localhost:${PORT}`);
  console.log(`  Admin dashboard  →  http://localhost:${PORT}/admin`);
  if (!env('ADMIN_PASSWORD')) console.log(`  Admin password is in data/admin-password.txt`);
  if (!PUBLIC_URL) console.log('  ℹ️  Live phone calls need PUBLIC_URL + Twilio settings in .env (see README).');
  console.log('');
});
