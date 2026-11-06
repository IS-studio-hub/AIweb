const API = String(window.AIWEB_API || '').replace(/\/+$/, '');
// FARQ admin dashboard
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = sessionStorage.getItem('farq.admin') || '';
let currency = 'USD';
const money = (n) => new Intl.NumberFormat(currency === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency }).format(n || 0);
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const variantLabel = (i) => [i.color, i.size].filter(Boolean).join(' / ');

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/api/admin/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- auth
function showLogin() { token = ''; sessionStorage.removeItem('farq.admin'); $('#app').hidden = true; $('#login').hidden = false; }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').hidden = true;
  try {
    const r = await fetch(API + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: e.target.password.value }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not sign in');
    token = d.token; sessionStorage.setItem('farq.admin', token);
    start();
  } catch (err) { $('#loginErr').textContent = err.message; $('#loginErr').hidden = false; }
});
$('#logout').addEventListener('click', showLogin);

// ---------------------------------------------------------------- navigation
let view = 'overview';
function go(v) {
  view = v;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $$('.view').forEach((s) => (s.hidden = s.id !== `view-${v}`));
  ({ overview: loadOverview, orders: loadOrders, products: loadProducts, settings: loadSettings, leads: loadLeads })[v]();
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); go(a.dataset.goto); } });

// ---------------------------------------------------------------- overview
let knownOrders = null;
async function refreshBadges() {
  const s = await api('summary');
  currency = s.currency;
  $('#navToShip').hidden = !s.toShip;
  $('#navToShip').textContent = s.toShip;
  document.title = s.toShip ? `(${s.toShip}) FARQ Admin` : 'FARQ Admin';
  if (knownOrders !== null && s.orders.all > knownOrders) toast('🛍️ New order received!');
  knownOrders = s.orders.all;
  return s;
}
async function loadOverview() {
  const [s, p, o] = await Promise.all([refreshBadges(), api('products'), api('orders?status=all')]);
  $('#sampleBanner').hidden = !p.products.some((x) => x.sample);
  $('#photoBanner').hidden = !p.products.some((x) => x.images.some((u) => u.startsWith('/images/farq/')));
  $('#ovUpdated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('#kpis').innerHTML = `
    <div class="kpi kpi--hl"><span>To ship</span><b>${s.toShip}</b><small>new + processing</small></div>
    <div class="kpi"><span>Revenue today</span><b>${money(s.revenue.today)}</b><small>${s.orders.today} orders</small></div>
    <div class="kpi"><span>Last 7 days</span><b>${money(s.revenue.week)}</b><small>${s.orders.week} orders</small></div>
    <div class="kpi"><span>All time</span><b>${money(s.revenue.all)}</b><small>${s.orders.all} orders</small></div>`;
  const open = o.orders.filter((x) => x.status === 'new' || x.status === 'processing').slice(0, 8);
  $('#ovToShip').innerHTML = open.length ? open.map((x) => `<div class="mini link" data-order="${esc(x.id)}"><span><b>${esc(x.id)}</b> · ${esc(x.customer.name)}<br><small class="muted">${when(x.createdAt)} · ${x.items.reduce((a, i) => a + i.qty, 0)} items</small></span><span>${money(x.total)}<br><span class="st st--${x.status}">${x.status}</span></span></div>`).join('') : '<p class="empty">Nothing waiting — nice.</p>';
  $('#ovTop').innerHTML = s.topProducts.length ? s.topProducts.map((t) => `<div class="mini"><span>${esc(t.name)}</span><b>${t.qty} sold</b></div>`).join('') : '<p class="muted">No sales yet.</p>';
  $('#ovLow').innerHTML = s.lowStock.length ? s.lowStock.map((l) => `<div class="mini"><span>${esc(l.product)} <small class="muted">${esc(l.variant)}</small></span><b class="stockx ${l.stock ? 'low' : 'out'}">${l.stock ? l.stock + ' left' : 'Sold out'}</b></div>`).join('') : '<p class="muted">All good.</p>';
  $$('#ovToShip [data-order]').forEach((el) => el.addEventListener('click', () => { go('orders'); openOrder(el.dataset.order); }));
}

// ---------------------------------------------------------------- orders
let orders = [], filter = 'open', selected = null;
$('#orderFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  filter = b.dataset.s;
  $$('#orderFilter button').forEach((x) => x.classList.toggle('on', x === b));
  renderOrders();
});
$('#orderSearch').addEventListener('input', renderOrders);

async function loadOrders() {
  await refreshBadges();
  orders = (await api('orders?status=all')).orders;
  renderOrders();
  if (selected) renderDetail(orders.find((o) => o.id === selected));
}
function renderOrders() {
  const q = $('#orderSearch').value.toLowerCase();
  const list = orders
    .filter((o) => filter === 'all' || (filter === 'open' ? ['new', 'processing'].includes(o.status) : o.status === filter))
    .filter((o) => !q || [o.id, o.customer.name, o.customer.email, o.customer.phone].join(' ').toLowerCase().includes(q));
  $('#orderTable tbody').innerHTML = list.map((o) => `
    <tr data-id="${esc(o.id)}" class="${o.id === selected ? 'sel' : ''}">
      <td><b>${esc(o.id)}</b><small>${o.items.reduce((a, i) => a + i.qty, 0)} items</small></td>
      <td>${when(o.createdAt)}</td>
      <td>${esc(o.customer.name)}<small>${esc(o.address.city)}, ${esc(o.address.country)}</small></td>
      <td>${money(o.total)}</td>
      <td><span class="st st--${o.payment.status}">${o.payment.status}</span><small>${o.payment.method === 'card' ? 'Card' : 'Pay later'}</small></td>
      <td><span class="st st--${o.status}">${o.status}</span></td>
    </tr>`).join('');
  $('#orderEmpty').hidden = !!list.length;
}
$('#orderTable').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openOrder(tr.dataset.id); });

async function openOrder(id) {
  selected = id;
  if (!orders.length) orders = (await api('orders?status=all')).orders;
  renderOrders();
  renderDetail(orders.find((o) => o.id === id));
}

function addressText(o) {
  const a = o.address;
  return [o.customer.name, a.line1, a.line2, `${a.city}${a.region ? ', ' + a.region : ''} ${a.postal}`, a.country].filter(Boolean).join('\n');
}

function renderDetail(o) {
  const el = $('#orderDetail');
  if (!o) { el.innerHTML = '<p class="empty">Select an order to see details and ship it.</p>'; return; }
  const tr = o.tracking || {};
  const mailBody = encodeURIComponent(`Hi ${o.customer.name.split(' ')[0]},\n\nGood news — your ${o.id} order is on its way!${tr.number ? `\nCarrier: ${tr.carrier}\nTracking: ${tr.number}${tr.url ? `\n${tr.url}` : ''}` : ''}\n\nThanks for shopping with us.`);
  el.innerHTML = `
    <div class="dhead"><div><h2>${esc(o.id)}</h2><small class="muted">${when(o.createdAt)} · via ${esc(o.source || 'chat')}</small></div>
      <div style="text-align:right"><span class="st st--${o.status}">${o.status}</span><br><span class="st st--${o.payment.status}" style="margin-top:6px">${o.payment.status}</span></div></div>
    ${o.items.some((i) => i.sample) ? '<p class="note">Contains sample (demo) products.</p>' : ''}
    <div class="dsec"><h4>Customer</h4><div class="contact"><b>${esc(o.customer.name)}</b><a href="mailto:${esc(o.customer.email)}">${esc(o.customer.email)}</a>${o.customer.phone ? `<a href="tel:${esc(o.customer.phone)}">${esc(o.customer.phone)}</a>` : ''}</div></div>
    <div class="dsec"><h4>Ship to</h4><div class="addr" id="addrBox">${esc(addressText(o))}<button class="btn btn--ghost btn--sm" type="button" id="copyAddr">Copy</button></div></div>
    ${o.note ? `<div class="dsec"><h4>Customer note</h4><p class="note">${esc(o.note)}</p></div>` : ''}
    <div class="dsec"><h4>Items</h4><div class="items">${o.items.map((i) => `<div class="item">${i.image ? `<img src="${esc(i.image)}" alt="">` : ''}<div>${i.qty} × ${esc(i.name)}<small>${esc(variantLabel(i))}</small></div><b>${money(i.price * i.qty)}</b></div>`).join('')}</div>
      <div class="totals"><div><span>Subtotal</span><span>${money(o.subtotal)}</span></div><div><span>Shipping</span><span>${o.shipping ? money(o.shipping) : 'Free'}</span></div>${o.tax ? `<div><span>Tax</span><span>${money(o.tax)}</span></div>` : ''}<div class="g"><span>Total</span><span>${money(o.total)}</span></div></div></div>
    <div class="dsec"><h4>Fulfillment</h4>
      <div class="actions">
        ${o.status === 'new' ? '<button class="btn btn--sm" data-act="processing">Start packing</button>' : ''}
        ${['new', 'processing'].includes(o.status) ? '<button class="btn btn--sm" data-act="ship">Mark as shipped…</button>' : ''}
        ${o.status === 'shipped' ? '<button class="btn btn--sm" data-act="delivered">Mark delivered</button><button class="btn btn--ghost btn--sm" data-act="ship">Edit tracking</button>' : ''}
        ${o.payment.status !== 'paid' && o.status !== 'cancelled' ? '<button class="btn btn--ghost btn--sm" data-act="paid">Mark paid</button>' : ''}
        <button class="btn btn--ghost btn--sm" data-act="slip">Print packing slip</button>
        <a class="btn btn--ghost btn--sm" href="mailto:${esc(o.customer.email)}?subject=${encodeURIComponent(`Your order ${o.id}`)}&body=${mailBody}">Email buyer</a>
        ${!['cancelled', 'delivered'].includes(o.status) ? '<button class="btn btn--ghost btn--danger btn--sm" data-act="cancelled">Cancel</button>' : ''}
      </div>
      <form class="shipform" id="shipForm" hidden>
        <label class="field"><span>Carrier</span><input name="carrier" value="${esc(tr.carrier || '')}" placeholder="Canada Post, UPS…" /></label>
        <label class="field"><span>Tracking number</span><input name="number" value="${esc(tr.number || '')}" /></label>
        <label class="field full"><span>Tracking link (optional)</span><input name="url" value="${esc(tr.url || '')}" placeholder="https://…" /></label>
        <div class="full actions"><button class="btn btn--sm" type="submit">Save &amp; mark shipped</button><button class="btn btn--ghost btn--sm" type="button" id="shipCancel">Cancel</button></div>
      </form>
      ${tr.number ? `<p class="small" style="margin:10px 0 0">Tracking: <b>${esc(tr.carrier)}</b> ${tr.url ? `<a href="${esc(tr.url)}" target="_blank" rel="noopener">${esc(tr.number)}</a>` : esc(tr.number)}</p>` : ''}
    </div>
    <div class="dsec"><h4>Add internal note</h4><form id="noteForm" class="actions"><input class="field" style="flex:1;background:#0f1215;border:1px solid var(--line-2);border-radius:10px;padding:8px 12px" name="n" placeholder="e.g. Packed with gift wrap" /><button class="btn btn--ghost btn--sm">Add</button></form></div>
    <div class="dsec"><h4>History</h4><ul class="timeline">${[...o.history].reverse().map((h) => `<li><time>${when(h.at)}</time><span>${esc(h.note || h.status)}</span></li>`).join('')}</ul></div>`;

  $('#copyAddr').addEventListener('click', async () => { await navigator.clipboard.writeText(addressText(o)); toast('Address copied'); });
  const shipForm = $('#shipForm');
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.act;
    if (a === 'ship') { shipForm.hidden = false; shipForm.carrier.focus(); return; }
    if (a === 'slip') return printSlip(o);
    if (a === 'cancelled' && !confirm(`Cancel order ${o.id}? (Stock is not restored automatically.)`)) return;
    const patch = a === 'paid' ? { paymentStatus: 'paid' } : { status: a };
    await save(o.id, patch, { processing: 'Marked as packing', delivered: 'Marked delivered', paid: 'Marked paid', cancelled: 'Order cancelled' }[a]);
  }));
  $('#shipCancel').addEventListener('click', () => (shipForm.hidden = true));
  shipForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await save(o.id, { status: 'shipped', tracking: { carrier: shipForm.carrier.value, number: shipForm.number.value, url: shipForm.url.value } }, 'Marked shipped — use “Email buyer” to send tracking');
  });
  $('#noteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = e.target.n.value.trim(); if (!n) return;
    await save(o.id, { internalNote: n }, 'Note added');
  });
}

async function save(id, patch, msg) {
  try {
    const { order } = await api(`orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
    orders = orders.map((o) => (o.id === id ? order : o));
    renderOrders(); renderDetail(order); refreshBadges();
    if (msg) toast(msg);
  } catch (e) { toast(e.message); }
}

function printSlip(o) {
  $('#slip').innerHTML = `
    <h1>Packing slip — ${esc(o.id)}</h1><div>${new Date(o.createdAt).toLocaleDateString()}</div>
    <div class="to"><b>SHIP TO</b>\n${esc(addressText(o))}${o.customer.phone ? '\n' + esc(o.customer.phone) : ''}</div>
    <table><thead><tr><th>Qty</th><th>Item</th><th>Variant</th></tr></thead><tbody>${o.items.map((i) => `<tr><td>${i.qty}</td><td>${esc(i.name)}</td><td>${esc(variantLabel(i))}</td></tr>`).join('')}</tbody></table>
    ${o.note ? `<p><b>Note:</b> ${esc(o.note)}</p>` : ''}<p style="margin-top:30px">Thank you for your order!</p>`;
  window.print();
}

// ---------------------------------------------------------------- products
let products = [], remote = false, editing = null, pImages = [];
async function loadProducts() {
  const d = await api('products');
  products = d.products; remote = d.remote;
  $('#remoteBanner').hidden = !remote;
  $('#newProduct').hidden = remote;
  $('#importBtn').hidden = remote;
  $('#pgrid').innerHTML = products.map((p) => {
    const stock = p.variants.reduce((a, v) => a + v.stock, 0);
    return `<div class="prod ${p.active ? '' : 'off'}" data-id="${esc(p.id)}">
      <div class="prod__img">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" loading="lazy">` : ''}${p.sample ? '<span class="tagx">SAMPLE</span>' : ''}</div>
      <div class="prod__b"><b>${esc(p.name)}</b><small>${esc(p.category)}${p.active ? '' : ' · hidden'}</small>
      <div class="row"><span>${p.notForSale ? '<small>In kits</small>' : money(p.price)}</span><span class="stockx ${stock === 0 ? 'out' : stock <= 5 ? 'low' : ''}">${p.notForSale ? '' : stock === 0 ? 'Sold out' : stock >= 999 ? 'In stock' : stock + ' in stock'}</span></div></div></div>`;
  }).join('') || '<p class="empty">No products yet — add your first one.</p>';
}
$('#pgrid').addEventListener('click', (e) => { const c = e.target.closest('.prod'); if (c && !remote) openProduct(products.find((p) => p.id === c.dataset.id)); });
$('#newProduct').addEventListener('click', () => openProduct(null));

const pf = $('#productForm');
function openProduct(p) {
  editing = p;
  $('#pTitle').textContent = p ? 'Edit product' : 'New product';
  $('#pErr').hidden = true;
  pf.name.value = p?.name || ''; pf.category.value = p?.category || '';
  pf.price.value = p?.price ?? ''; pf.compareAtPrice.value = p?.compareAtPrice ?? '';
  pf.active.checked = p ? p.active : true;
  pf.priceNote.value = p?.priceNote || '';
  pf.notForSale.checked = !!p?.notForSale;
  pf.description.value = p?.description || '';
  pf.highlights.value = (p?.highlights || []).join('\n');
  pf.tags.value = (p?.tags || []).join(', ');
  pf.colors.value = (p?.colors || []).join(', ');
  pf.sizes.value = (p?.sizes || []).join(', ');
  pImages = [...(p?.images || [])];
  renderImages(); renderStock(p?.variants || []);
  $('#pDelete').hidden = !p;
  $('#productDialog').showModal();
}
const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
function renderImages() {
  $('#pImages').innerHTML = pImages.map((u, i) => `<figure><img src="${esc(u)}" alt=""><button type="button" data-i="${i}" aria-label="Remove">×</button></figure>`).join('');
}
$('#pImages').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) { pImages.splice(+b.dataset.i, 1); renderImages(); } });
$('#pImgUrl').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = e.target.value.trim(); if (v) { pImages.push(v); e.target.value = ''; renderImages(); }
});
$('#pUpload').addEventListener('change', async (e) => {
  for (const f of e.target.files) {
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    try { const { url } = await api('upload', { method: 'POST', body: { data } }); pImages.push(url); renderImages(); }
    catch (err) { toast(err.message); }
  }
  e.target.value = '';
});
function currentStockMap() {
  const m = new Map();
  $$('#pStock input').forEach((i) => m.set(i.dataset.k, +i.value || 0));
  return m;
}
function renderStock(variants) {
  const prev = currentStockMap();
  const vmap = new Map(variants.map((v) => [`${v.color || ''}|${v.size || ''}`, v.stock]));
  const colors = splitList(pf.colors.value), sizes = splitList(pf.sizes.value);
  const combos = (colors.length ? colors : [null]).flatMap((c) => (sizes.length ? sizes : [null]).map((s) => [c, s]));
  $('#pStock').innerHTML = combos.map(([c, s]) => {
    const k = `${c || ''}|${s || ''}`;
    const val = prev.get(k) ?? vmap.get(k) ?? 0;
    return `<label>${esc([c, s].filter(Boolean).join(' / ') || 'Stock')}<input type="number" min="0" step="1" data-k="${esc(k)}" value="${val}"></label>`;
  }).join('');
}
pf.colors.addEventListener('input', () => renderStock(editing?.variants || []));
pf.sizes.addEventListener('input', () => renderStock(editing?.variants || []));

pf.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return $('#productDialog').close();
  if (!pf.name.value.trim() || pf.price.value === '') { $('#pErr').textContent = 'Name and price are required.'; $('#pErr').hidden = false; return; }
  const stock = currentStockMap();
  const body = {
    name: pf.name.value, category: pf.category.value, price: +pf.price.value,
    compareAtPrice: pf.compareAtPrice.value ? +pf.compareAtPrice.value : null,
    active: pf.active.checked, description: pf.description.value,
    priceNote: pf.priceNote.value, notForSale: pf.notForSale.checked,
    highlights: pf.highlights.value.split('\n').map((x) => x.trim()).filter(Boolean),
    tags: splitList(pf.tags.value), colors: splitList(pf.colors.value), sizes: splitList(pf.sizes.value),
    images: pImages,
    variants: [...stock].map(([k, v]) => { const [color, size] = k.split('|'); return { color: color || null, size: size || null, stock: v }; }),
  };
  try {
    if (editing) await api(`products/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
    else await api('products', { method: 'POST', body });
    $('#productDialog').close(); toast('Product saved'); loadProducts();
  } catch (err) { $('#pErr').textContent = err.message; $('#pErr').hidden = false; }
});
// ---------------------------------------------------------------- CSV import (Shopify export or FARQ template)
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const stripHtml = (h) => { const d = document.createElement('div'); d.innerHTML = h; return (d.textContent || '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim(); };
const pipeList = (s) => String(s || '').split(/\s*[|\n]\s*/).map((x) => x.trim()).filter(Boolean);
const uniq = (a) => [...new Set(a)];

function fromShopify(rows) {
  const by = new Map();
  for (const r of rows) {
    const h = r['handle']; if (!h) continue;
    if (!by.has(h)) by.set(h, { id: h, rows: [] });
    by.get(h).rows.push(r);
  }
  const out = [];
  for (const { id, rows: rs } of by.values()) {
    const first = rs.find((r) => r['title']) || rs[0];
    const optNames = [1, 2, 3].map((n) => (first[`option${n} name`] || '').toLowerCase());
    const colorIdx = optNames.findIndex((n) => /colou?r/.test(n));
    const sizeIdx = optNames.findIndex((n, i) => n && i !== colorIdx && n !== 'title');
    const variants = [], colors = [], sizes = [];
    let price = null, compare = null;
    for (const r of rs) {
      if (!r['variant price'] && !r['variant sku'] && !r['option1 value']) continue;
      const color = colorIdx >= 0 ? r[`option${colorIdx + 1} value`] || null : null;
      let size = sizeIdx >= 0 ? r[`option${sizeIdx + 1} value`] || null : null;
      if (size === 'Default Title') size = null;
      if (color) colors.push(color);
      if (size) sizes.push(size);
      const tracked = r['variant inventory tracker'] && r['variant inventory qty'] !== '';
      variants.push({ color, size, stock: tracked ? Math.max(0, +r['variant inventory qty'] || 0) : 99 });
      if (price === null && r['variant price']) price = +r['variant price'];
      if (compare === null && r['variant compare at price']) compare = +r['variant compare at price'];
    }
    const images = rs.filter((r) => r['image src']).sort((a, b) => (+a['image position'] || 0) - (+b['image position'] || 0)).map((r) => r['image src']);
    for (const r of rs) if (r['variant image'] && !images.includes(r['variant image'])) images.push(r['variant image']);
    const status = (first['status'] || '').toLowerCase();
    out.push({
      id, name: first['title'], category: first['type'] || (first['product category'] || '').split('>').pop().trim(),
      description: stripHtml(first['body (html)'] || ''), highlights: [],
      tags: (first['tags'] || '').split(',').map((t) => t.trim()).filter(Boolean),
      price: price || 0, compareAtPrice: compare && compare > (price || 0) ? compare : null,
      images: uniq(images), colors: uniq(colors), sizes: uniq(sizes), variants,
      active: status ? status === 'active' : (first['published'] || 'true').toLowerCase() !== 'false',
    });
  }
  return out;
}

function fromTemplate(rows) {
  return rows.filter((r) => r.name).map((r) => {
    const colors = (r.colors || '').split(',').map((x) => x.trim()).filter(Boolean);
    const sizes = (r.sizes || '').split(',').map((x) => x.trim()).filter(Boolean);
    const stock = r.stock === '' || r.stock == null ? 99 : Math.max(0, +r.stock || 0);
    const variants = (colors.length ? colors : [null]).flatMap((c) => (sizes.length ? sizes : [null]).map((s) => ({ color: c, size: s, stock })));
    return {
      id: r.id || '', name: r.name, category: r.category || '', price: +r.price || 0,
      compareAtPrice: +r.compare_at_price || null, description: r.description || '',
      highlights: pipeList(r.selling_points), tags: (r.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      colors, sizes, variants, images: pipeList(r.image_urls), active: (r.active || 'yes').toLowerCase() !== 'no',
    };
  });
}

let importing = [];
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const rows = parseCSV(await f.text());
  const isShopify = rows.length && 'handle' in rows[0] && 'title' in rows[0];
  importing = isShopify ? fromShopify(rows) : fromTemplate(rows);
  $('#importErr').hidden = true;
  if (!importing.length) { toast('No products found – use the template or a Shopify product export.'); return; }
  const noImg = importing.filter((p) => !p.images.length).length;
  $('#importSummary').innerHTML = `${importing.length} products found (${isShopify ? 'Shopify export' : 'template'}).${noImg ? ` <b>${noImg}</b> have no image.` : ''} Products with the same name are updated.`;
  $('#importList').innerHTML = importing.map((p) => `<div class="ir">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" loading="lazy">` : '<span class="ph"></span>'}<div><b>${esc(p.name)}</b><small>${esc(p.category)} · ${p.images.length} photo${p.images.length === 1 ? '' : 's'} · ${p.variants.length} variant${p.variants.length === 1 ? '' : 's'}${p.active ? '' : ' · hidden'}</small></div><span>${money(p.price)}</span></div>`).join('');
  $('#importDialog').showModal();
});
$('#importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return $('#importDialog').close();
  $('#importGo').disabled = true;
  try {
    const r = await api('products/import', { method: 'POST', body: { products: importing, removeSamples: e.target.removeSamples.checked } });
    $('#importDialog').close();
    toast(`Imported: ${r.added} new, ${r.updated} updated${r.removed ? `, ${r.removed} samples removed` : ''}`);
    loadProducts();
  } catch (err) { $('#importErr').textContent = err.message; $('#importErr').hidden = false; }
  finally { $('#importGo').disabled = false; }
});

$('#pDelete').addEventListener('click', async () => {
  if (!editing || !confirm(`Delete “${editing.name}”?`)) return;
  await api(`products/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
  $('#productDialog').close(); toast('Product deleted'); loadProducts();
});

// ---------------------------------------------------------------- settings
const sf = $('#settingsForm');
async function loadSettings() {
  const [d, p] = await Promise.all([api('settings'), api('prompt')]);
  const s = d.settings;
  for (const k of ['storeName', 'assistantName', 'currency', 'flatShipping', 'freeShippingOver', 'taxRate', 'about', 'policies', 'contact']) sf[k].value = s[k] ?? '';
  sf.payOnDelivery.checked = s.payOnDelivery !== false;
  $('#promptForm').prompt.value = p.prompt;
  const ok = (b) => (b ? '<span class="st st--delivered">connected</span>' : '<span class="st st--cancelled">not set</span>');
  $('#conn').innerHTML = `
    <li><b>AI model</b><span>${esc(d.ai.model)} <small class="muted">@ ${esc(d.ai.base.replace(/^https?:\/\//, ''))}</small></span></li>
    <li><b>Product catalog</b><span>${d.remoteCatalog ? 'Your API (CATALOG_API_URL)' : 'Local (edit in Products)'}</span></li>
    <li><b>Card payments (Stripe)</b>${ok(d.stripe)}</li>`;
}
sf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ['storeName', 'assistantName', 'currency', 'about', 'policies', 'contact']) body[k] = sf[k].value;
  for (const k of ['flatShipping', 'freeShippingOver', 'taxRate']) body[k] = +sf[k].value;
  body.currency = body.currency.toUpperCase();
  body.payOnDelivery = sf.payOnDelivery.checked;
  try { await api('settings', { method: 'PUT', body }); flash('#settingsSaved'); currency = body.currency; } catch (err) { toast(err.message); }
});
$('#promptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('prompt', { method: 'PUT', body: { prompt: e.target.prompt.value } }); flash('#promptSaved'); } catch (err) { toast(err.message); }
});
function flash(sel) { $(sel).hidden = false; setTimeout(() => ($(sel).hidden = true), 2000); }

// ---------------------------------------------------------------- leads
async function loadLeads() {
  const { leads } = await api('leads');
  $('#leadTable tbody').innerHTML = leads.map((l) => `<tr><td>${when(l.at)}</td><td>${esc(l.firstName)} ${esc(l.lastName)}</td><td><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></td><td><a href="tel:${esc(l.phone)}">${esc(l.phone)}</a></td></tr>`).join('');
  $('#leadEmpty').hidden = !!leads.length;
}

// ---------------------------------------------------------------- start
async function start() {
  $('#login').hidden = true; $('#app').hidden = false;
  try { await refreshBadges(); go(view); } catch {}
}
setInterval(() => {
  if (!token || $('#app').hidden) return;
  if (view === 'orders') loadOrders().catch(() => {});
  else if (view === 'overview') loadOverview().catch(() => {});
  else refreshBadges().catch(() => {});
}, 15000);

if (token) start(); else showLogin();
