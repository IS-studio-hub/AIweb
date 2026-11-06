const API = String(window.AIWEB_API || '').replace(/\/+$/, '');
import { createCharacter } from './character.js';

// ================================================================ 3D stage
const stageEl = document.getElementById('stage');
const loader = document.getElementById('loader');
const loadBar = document.getElementById('loadBar');
const speakingBadge = document.getElementById('speakingBadge');
let character = null;

createCharacter(stageEl, { onProgress: (p) => (loadBar.style.width = `${Math.round(p * 100)}%`) })
  .then((c) => { character = c; loader.classList.add('is-done'); })
  .catch((err) => { console.error(err); loader.querySelector('p').textContent = 'Could not load the 3D character.'; });

// ================================================================ helpers
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtText = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
async function safeJson(res) { try { return await res.json(); } catch { return null; } }
const store = { storeName: 'FARQ', assistantName: 'Max', currency: 'USD', payments: { card: false, payLater: true }, freeShippingOver: 0 };
const money = (n) => new Intl.NumberFormat(store.currency === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency: store.currency }).format(n || 0);
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let sid = LS.get('farq.sid', null);
if (!sid) {
  sid = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, '');
  LS.set('farq.sid', sid);
}

const icons = {
  mic: '<svg viewBox="0 0 24 24"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15Z"/><path d="M18.5 11.5a6.5 6.5 0 0 1-13 0M12 18v3"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
  bag: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
};

// ================================================================ chat
const scrollEl = $('scroll');
const list = $('messages');
const intro = $('intro');
const form = $('composer');
const input = $('input');
const sendBtn = $('sendBtn');
const micBtn = $('micBtn');
const recorderEl = $('recorder');
const recTime = $('recTime');
const wave = $('wave');
const statusEl = document.querySelector('.status');
const statusText = document.querySelector('.status__text');

let chatLog = LS.get(`farq.history.${sid}`, []);
let busy = false;
const saveLog = () => { chatLog = chatLog.slice(-40); LS.set(`farq.history.${sid}`, chatLog); };
const scrollDown = () => requestAnimationFrame(() => { scrollEl.scrollTop = scrollEl.scrollHeight; });

function setStatus(text, isBusy) { statusText.textContent = text; statusEl.classList.toggle('is-busy', !!isBusy); }

function addMessage(role, text = '', { meta, error } = {}) {
  intro.classList.add('is-hidden');
  const li = document.createElement('li');
  li.className = `msg msg--${role === 'user' ? 'user' : role === 'event' ? 'event' : 'ai'}${error ? ' msg--error' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg__bubble';
  bubble.innerHTML = fmtText(text);
  li.appendChild(bubble);
  if (meta) { const m = document.createElement('div'); m.className = 'msg__meta'; m.innerHTML = meta; li.appendChild(m); }
  list.appendChild(li);
  scrollDown();
  return { li, bubble };
}
function typingBubble() {
  const m = addMessage('assistant');
  m.bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  return m;
}
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  sendBtn.disabled = !input.value.trim() || busy;
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  if (chip.dataset.action === 'call') return openCallDialog();
  input.value = chip.textContent; autosize(); form.requestSubmit();
}));

// Restore the previous conversation (text only)
for (const m of chatLog) {
  if (m.role === 'user' && m.content.startsWith('[event]')) continue;
  addMessage(m.role, m.content);
}

// New chat: clears the conversation (the bag is kept)
$('newChatBtn').addEventListener('click', () => {
  if (busy || rec) return;
  stopPlayback();
  chatLog = [];
  saveLog();
  list.innerHTML = '';
  intro.classList.remove('is-hidden');
  scrollEl.scrollTop = 0;
  input.value = ''; autosize(); input.focus();
  setStatus('Online');
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = ''; autosize();
  addMessage('user', text);
  sendToAssistant(text);
});

/** Sends a message (or an [event]) and renders the streamed answer + cards. */
async function sendToAssistant(text) {
  chatLog.push({ role: 'user', content: text });
  saveLog();
  busy = true; setStatus(`${store.assistantName} is typing…`, true); autosize();
  const { li, bubble } = typingBubble();
  let answer = '', gotEvent = false;
  try {
    const res = await fetch(API + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, messages: chatLog.slice(-24) }),
    });
    if (!res.ok || !res.body) throw new Error((await safeJson(res))?.error || `Request failed (${res.status})`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.t === 'text') { answer += ev.d; if (answer.trim()) bubble.innerHTML = fmtText(answer.trim()); }
        else if (ev.t === 'error') throw new Error(ev.message);
        else if (ev.t === 'status') setStatus(`${store.assistantName} is checking…`, true);
        else if (ev.t !== 'done') { gotEvent = true; handleEvent(ev, li); }
        scrollDown();
      }
    }
    if (!answer.trim() && !gotEvent) throw new Error('No answer – please try again.');
    if (!answer.trim()) bubble.remove();
    else { chatLog.push({ role: 'assistant', content: answer.trim() }); saveLog(); }
  } catch (err) {
    li.classList.add('msg--error');
    bubble.textContent = /failed to fetch|load failed|networkerror|\((404|405)\)/i.test(err.message) ? 'Sorry — the chat server isn’t reachable right now. Please try again in a moment.' : `Sorry — ${err.message}`;
  } finally {
    busy = false; setStatus('Online'); autosize();
  }
}

function handleEvent(ev, li) {
  if (ev.t === 'products') li.appendChild(ev.layout === 'grid' ? renderGrid(ev) : renderProducts(ev.items));
  else if (ev.t === 'cart') { setCart(ev.cart); if (ev.added) li.appendChild(renderAddedChip(ev.cart)); if (ev.show) openBag(); }
  else if (ev.t === 'checkout') { if (ev.url) li.appendChild(renderCheckoutLink(ev.url)); else openCheckout(); }
  else if (ev.t === 'order') li.appendChild(renderOrder(ev.order));
}

// ================================================================ product cards
function renderProducts(items) {
  const wrap = document.createElement('div');
  wrap.className = 'cards';
  for (const p of items) wrap.appendChild(productCard(p));
  return wrap;
}

const GRID_PAGE = 24;
function renderGrid(ev) {
  const box = document.createElement('section');
  box.className = 'pgrid';
  const items = ev.items || [];
  box.innerHTML = `<header class="pgrid__head"><span>${esc(ev.title || 'Products')}</span><small>${items.length} item${items.length === 1 ? '' : 's'}</small></header>`;
  const grid = document.createElement('div');
  grid.className = 'cards cards--grid';
  box.appendChild(grid);
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'pgrid__more';
  box.appendChild(more);
  let shown = 0;
  const page = () => {
    for (const p of items.slice(shown, shown + GRID_PAGE)) grid.appendChild(productCard(p));
    shown = Math.min(items.length, shown + GRID_PAGE);
    const left = items.length - shown;
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(left, GRID_PAGE)} more (${left} left)`;
  };
  more.addEventListener('click', page);
  page();
  return box;
}

function productCard(p) {
  const el = document.createElement('article');
  el.className = 'pcard';
  let img = 0;
  let color = p.colors.length === 1 ? p.colors[0] : null;
  let size = null;
  const sale = p.compareAtPrice && p.compareAtPrice > p.price;
  el.innerHTML = `
    <div class="pcard__media">
      ${p.images.length ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="lazy" />` : '<div class="pcard__noimg">No photo</div>'}
      ${p.images.length > 1 ? `<div class="pcard__dots">${p.images.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
      <div class="pcard__tags">${sale ? '<span class="tag tag--sale">Sale</span>' : ''}${p.sample ? '<span class="tag tag--sample">Sample</span>' : ''}</div>
    </div>
    <div class="pcard__body">
      <p class="pcard__cat">${esc(p.category)}</p>
      <h4 class="pcard__name">${esc(p.name)}</h4>
      ${p.notForSale
        ? `<p class="pcard__incl">Comes in ${esc((p.availableInNames || []).join(' & ') || 'our kits')}</p>`
        : `<p class="pcard__price">${money(p.price)}${sale ? ` <s>${money(p.compareAtPrice)}</s>` : ''}${p.priceNote ? ` <small class="pcard__pnote">${esc(p.priceNote)}</small>` : ''}</p>`}
      ${p.includesNames?.length ? `<p class="pcard__includes">Includes: ${p.includesNames.map(esc).join(' · ')}</p>` : ''}
      ${p.colors.length > 1 ? `<div class="opts" data-kind="color">${p.colors.map((c) => `<button type="button" class="opt" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : (p.colors[0] ? `<p class="pcard__solo">${esc(p.colors[0])}</p>` : '')}
      ${p.sizes.length ? `<div class="opts" data-kind="size">${p.sizes.map((s) => `<button type="button" class="opt opt--size" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
      <p class="pcard__note" aria-live="polite"></p>
      <button type="button" class="pcard__add">${p.notForSale ? 'See the kits' : 'Add to bag'}</button>
      ${p.url ? `<a class="pcard__link" href="${esc(p.url)}" target="_blank" rel="noopener">View on site ↗</a>` : ''}
      ${p.description ? `<details class="pcard__more"><summary>Details</summary><p>${esc(p.description)}</p>${p.highlights?.length ? `<ul>${p.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}</details>` : ''}
    </div>`;
  const imgEl = el.querySelector('.pcard__media img');
  const note = el.querySelector('.pcard__note');
  const addBtn = el.querySelector('.pcard__add');
  if (imgEl && p.images.length > 1) {
    el.querySelector('.pcard__media').addEventListener('click', () => {
      img = (img + 1) % p.images.length;
      imgEl.src = p.images[img];
      el.querySelectorAll('.pcard__dots i').forEach((d, i) => d.classList.toggle('on', i === img));
    });
  }
  const stockFor = (c, s) => p.variants.filter((v) => (!c || !v.color || v.color === c) && (!s || !v.size || v.size === s)).reduce((a, v) => a + v.stock, 0);
  const refresh = () => {
    el.querySelectorAll('[data-kind="color"] .opt').forEach((b) => b.classList.toggle('on', b.dataset.v === color));
    el.querySelectorAll('[data-kind="size"] .opt').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === size);
      const out = stockFor(color, b.dataset.v) <= 0;
      b.disabled = out; b.classList.toggle('is-out', out);
    });
    const ready = (!p.sizes.length || size) && (p.colors.length <= 1 || color);
    const left = ready ? stockFor(color, size) : stockFor(color, null);
    note.textContent = ready && left > 0 && left <= 3 ? `Only ${left} left` : left <= 0 && ready ? 'Sold out' : '';
    addBtn.disabled = !p.notForSale && !!(ready && left <= 0);
    if (p.notForSale) note.textContent = '';
  };
  el.querySelectorAll('.opts').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('.opt'); if (!b || b.disabled) return;
    if (g.dataset.kind === 'color') color = b.dataset.v; else size = b.dataset.v;
    refresh();
  }));
  addBtn.addEventListener('click', async () => {
    if (p.notForSale) {
      if (busy) return;
      const q = `Which kit includes the ${p.name}?`;
      addMessage('user', q); sendToAssistant(q);
      return;
    }
    if (p.colors.length > 1 && !color) { note.textContent = 'Pick a colour'; return; }
    if (p.sizes.length && !size) {
      note.textContent = 'Pick a size';
      const g = el.querySelector('[data-kind="size"]'); g?.classList.add('shake'); setTimeout(() => g?.classList.remove('shake'), 400);
      return;
    }
    addBtn.disabled = true; addBtn.textContent = 'Adding…';
    const res = await fetch(API + '/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, action: 'add', productId: p.id, color, size, qty: 1 }) });
    const data = await safeJson(res);
    if (!res.ok) { note.textContent = data?.error || 'Could not add.'; addBtn.disabled = false; addBtn.textContent = 'Add to bag'; return; }
    setCart(data.cart);
    addBtn.innerHTML = `${icons.check} Added`;
    addBtn.classList.add('is-added');
    setTimeout(() => { addBtn.textContent = 'Add to bag'; addBtn.classList.remove('is-added'); addBtn.disabled = false; refresh(); }, 1600);
    const what = `${p.name}${[color, size].filter(Boolean).length ? ` (${[color, size].filter(Boolean).join(', ')})` : ''}`;
    addMessage('event', `Added ${what} to bag`);
    if (!busy) sendToAssistant(`[event] I tapped "Add to bag" on ${what}. Bag subtotal is now ${money(data.cart.subtotal)}.`);
  });
  refresh();
  return el;
}

function renderAddedChip(c) {
  const d = document.createElement('button');
  d.type = 'button';
  d.className = 'added-chip';
  d.innerHTML = `${icons.bag}<span>Bag · ${c.count} item${c.count === 1 ? '' : 's'} · ${money(c.subtotal)}</span><b>View bag</b>`;
  d.addEventListener('click', openBag);
  return d;
}

function renderOrder(o) {
  const d = document.createElement('div');
  d.className = 'order-card';
  const label = { new: 'Order received', processing: 'Being prepared', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' }[o.status] || o.status;
  const pay = o.payment?.status === 'paid' ? ' · Paid' : o.payment?.method === 'pay_later' ? ' · Pay later' : '';
  d.innerHTML = `
    <div class="order-card__head"><span class="order-card__check">${icons.check}</span><div><b>${esc(o.id)}</b><small>${label}${pay}</small></div><strong>${money(o.total)}</strong></div>
    <ul>${o.items.map((i) => `<li>${i.image ? `<img src="${esc(i.image)}" alt="">` : ''}<span>${i.qty} × ${esc(i.name)}${[i.color, i.size].filter(Boolean).length ? ` <em>${esc([i.color, i.size].filter(Boolean).join(' / '))}</em>` : ''}</span><b>${money(i.price * i.qty)}</b></li>`).join('')}</ul>
    ${o.tracking?.number ? `<p class="order-card__track">Tracking: ${esc(o.tracking.carrier)} ${o.tracking.url ? `<a href="${esc(o.tracking.url)}" target="_blank" rel="noopener">${esc(o.tracking.number)}</a>` : esc(o.tracking.number)}</p>` : ''}
    <p class="order-card__ship">Ships to ${esc(o.shipTo)}</p>`;
  return d;
}

// ================================================================ bag
const bagBtn = $('bagBtn'), bagCount = $('bagCount'), bag = $('bag'), bagLines = $('bagLines');
let cart = { lines: [], count: 0, subtotal: 0, shipping: 0, total: 0 };

function setCart(c) {
  const grew = c.count > cart.count;
  cart = c;
  bagCount.textContent = c.count;
  bagCount.hidden = !c.count;
  if (grew) { bagBtn.classList.remove('bump'); void bagBtn.offsetWidth; bagBtn.classList.add('bump'); }
  renderBag();
}
function renderBag() {
  if (!cart.lines.length) {
    bagLines.innerHTML = `<p class="bag__empty">Your bag is empty.<br>Tell ${esc(store.assistantName)} what you’re looking for.</p>`;
  } else {
    bagLines.innerHTML = cart.lines.map((l) => `
      <div class="bline" data-line="${esc(l.lineId)}">
        ${l.image ? `<img src="${esc(l.image)}" alt="">` : '<span class="bline__ph"></span>'}
        <div class="bline__info"><b>${esc(l.name)}</b><small>${esc([l.color, l.size].filter(Boolean).join(' / '))}</small>
          <div class="qty"><button type="button" data-q="-1" aria-label="Less">−</button><span>${l.qty}</span><button type="button" data-q="1" aria-label="More" ${l.qty >= l.stock ? 'disabled' : ''}>+</button></div></div>
        <div class="bline__price">${money(l.lineTotal)}<button type="button" class="bline__rm" data-q="rm">Remove</button></div>
      </div>`).join('');
  }
  $('bagSubtotal').textContent = money(cart.subtotal);
  $('bagShipping').textContent = !cart.lines.length ? '—' : cart.externalCheckout ? 'At checkout' : cart.shipping ? money(cart.shipping) : 'Free';
  $('bagTotal').textContent = money(cart.total);
  const prog = $('bagFree');
  if (cart.lines.length && cart.freeShippingOver) {
    prog.hidden = false;
    prog.querySelector('span').textContent = cart.toFreeShipping ? `${money(cart.toFreeShipping)} away from free shipping` : 'You’ve unlocked free shipping';
    prog.querySelector('i').style.width = Math.min(100, (cart.subtotal / cart.freeShippingOver) * 100) + '%';
  } else prog.hidden = true;
  $('bagCheckout').disabled = !cart.lines.length;
}
bagLines.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-q]'); if (!b) return;
  const line = cart.lines.find((l) => l.lineId === b.closest('.bline').dataset.line);
  if (!line) return;
  const qty = b.dataset.q === 'rm' ? 0 : line.qty + Number(b.dataset.q);
  const res = await fetch(API + '/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, action: 'update', lineId: line.lineId, qty }) });
  const data = await safeJson(res);
  if (data?.cart) setCart(data.cart);
});
function openBag() { bag.hidden = false; requestAnimationFrame(() => bag.classList.add('is-open')); }
function closeBag() { bag.classList.remove('is-open'); setTimeout(() => (bag.hidden = true), 250); }
bagBtn.addEventListener('click', () => (bag.hidden ? openBag() : closeBag()));
$('bagClose').addEventListener('click', closeBag);
bag.addEventListener('click', (e) => { if (e.target === bag) closeBag(); });
$('bagCheckout').addEventListener('click', () => {
  closeBag();
  if (cart.externalCheckout) return goToExternalCheckout();
  openCheckout();
});

// Store's own (Shopify) checkout: opens in a new tab with the bag already filled in.
async function goToExternalCheckout() {
  const w = window.open('', '_blank');
  const data = await fetch(API + '/api/checkout-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid }) }).then((r) => r.json()).catch(() => null);
  if (data?.url) { if (w) w.location = data.url; else location.href = data.url; }
  else { w?.close(); addMessage('assistant', data?.error || 'Could not open checkout – please try again.', { error: true }); }
}
function renderCheckoutLink(url) {
  const a = document.createElement('a');
  a.className = 'checkout-link'; a.href = url; a.target = '_blank'; a.rel = 'noopener';
  a.innerHTML = `${icons.bag}<span>Go to secure checkout</span><b>→</b>`;
  return a;
}

// ================================================================ checkout
const coDialog = $('checkoutDialog'), coForm = $('checkoutForm'), coError = $('coError'), coSubmit = $('coSubmit');

function openCheckout() {
  if (!cart.lines.length) return;
  coError.hidden = true;
  $('coSummary').innerHTML = cart.lines.map((l) => `<li>${l.image ? `<img src="${esc(l.image)}" alt="">` : ''}<span>${l.qty} × ${esc(l.name)} <em>${esc([l.color, l.size].filter(Boolean).join(' / '))}</em></span><b>${money(l.lineTotal)}</b></li>`).join('') +
    `<li class="co-tot"><span>Shipping</span><b>${cart.shipping ? money(cart.shipping) : 'Free'}</b></li>` +
    (cart.tax ? `<li class="co-tot"><span>Tax</span><b>${money(cart.tax)}</b></li>` : '') +
    `<li class="co-tot co-grand"><span>Total</span><b>${money(cart.total)}</b></li>`;
  $('coPay').innerHTML = [
    store.payments.card && '<label class="payopt"><input type="radio" name="paymentMethod" value="card" checked> <span><b>Card</b><small>Secure checkout by Stripe</small></span></label>',
    store.payments.payLater && `<label class="payopt"><input type="radio" name="paymentMethod" value="pay_later" ${store.payments.card ? '' : 'checked'}> <span><b>Pay later</b><small>We’ll contact you to arrange payment</small></span></label>`,
  ].filter(Boolean).join('');
  const saved = LS.get('farq.customer', null);
  if (saved) for (const [k, v] of Object.entries(saved)) if (coForm[k] && !coForm[k].value) coForm[k].value = v;
  coDialog.showModal();
}
coDialog.addEventListener('click', (e) => { if (e.target === coDialog) coDialog.close(); });

coForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return coDialog.close();
  const f = coForm;
  const val = (n) => f[n].value.trim();
  const body = {
    sid,
    customer: { name: val('name'), email: val('email'), phone: val('phone') },
    address: { line1: val('line1'), line2: val('line2'), city: val('city'), region: val('region'), postal: val('postal'), country: val('country') },
    paymentMethod: f.querySelector('input[name="paymentMethod"]:checked')?.value || 'pay_later',
    note: val('note'),
  };
  f.querySelectorAll('input').forEach((i) => i.classList.remove('is-invalid'));
  const missing = ['name', 'email', 'line1', 'city', 'postal', 'country'].filter((n) => !val(n) || (n === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val(n))));
  if (missing.length) {
    missing.forEach((n) => f[n].classList.add('is-invalid'));
    coError.textContent = 'Please fill in the highlighted fields.'; coError.hidden = false; f[missing[0]].focus();
    return;
  }
  coSubmit.disabled = true; coSubmit.textContent = 'Placing order…';
  try {
    const res = await fetch(API + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error || 'Could not place the order.');
    LS.set('farq.customer', { name: body.customer.name, email: body.customer.email, phone: body.customer.phone, ...body.address });
    if (data.redirectUrl) { location.href = data.redirectUrl; return; }
    coDialog.close();
    setCart({ lines: [], count: 0, subtotal: 0, shipping: 0, total: 0, tax: 0 });
    orderPlaced(data.order, data.warning);
  } catch (err) {
    coError.textContent = err.message; coError.hidden = false;
  } finally {
    coSubmit.disabled = false; coSubmit.textContent = 'Place order';
  }
});

function orderPlaced(order, warning) {
  const m = addMessage('event', `Order ${order.id} placed`);
  m.li.appendChild(renderOrder(order));
  if (warning) addMessage('assistant', warning, { error: true });
  const pay = order.payment.method === 'card' ? (order.payment.status === 'paid' ? 'paid by card' : 'card payment pending') : 'pay later';
  sendToAssistant(`[event] I just placed order ${order.id} (total ${money(order.total)}, payment: ${pay}).`);
}

// Coming back from Stripe checkout
(async () => {
  const q = new URLSearchParams(location.search);
  if (!q.get('order')) return;
  window.history.replaceState(null, '', location.pathname);
  const res = await fetch(API + '/api/order/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: q.get('order'), token: q.get('t'), sessionId: q.get('session_id') }) });
  const data = await safeJson(res);
  if (!data?.order) return;
  if (q.get('cancelled')) addMessage('assistant', `No worries — order ${data.order.id} is saved but not paid yet. Message me if you'd like to finish it.`);
  else orderPlaced(data.order);
})();

// ================================================================ voice question → voice answer
let rec = null;
micBtn.addEventListener('click', () => { if (rec) return rec.stop(); if (busy) return; startRecording(); });

async function startRecording() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { addMessage('assistant', 'I need microphone access to hear you. Please allow the mic in your browser and try again.', { error: true }); return; }
  stopPlayback();
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const ac = new AudioContext();
  const an = ac.createAnalyser(); an.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const ctx = wave.getContext('2d');
  const started = performance.now();
  let heardSpeech = false, lastLoud = performance.now(), raf = 0;
  const levels = [];
  const draw = () => {
    an.getByteTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length), now = performance.now();
    if (rms > 0.035) { heardSpeech = true; lastLoud = now; }
    levels.push(rms); if (levels.length > 90) levels.shift();
    ctx.clearRect(0, 0, wave.width, wave.height); ctx.fillStyle = '#d6ff5c';
    const bw = wave.width / 90;
    levels.forEach((l, i) => { const h = Math.max(3, Math.min(wave.height, l * wave.height * 6)); ctx.fillRect(i * bw, (wave.height - h) / 2, bw * 0.55, h); });
    const secs = Math.floor((now - started) / 1000);
    recTime.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if ((heardSpeech && now - lastLoud > 1500) || now - started > 45000) return mr.stop();
    raf = requestAnimationFrame(draw);
  };
  mr.onstop = async () => {
    cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ac.close(); rec = null;
    form.classList.remove('is-recording'); recorderEl.hidden = true; micBtn.classList.remove('is-recording'); micBtn.setAttribute('aria-label', 'Ask by voice');
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    if (!heardSpeech || blob.size < 2000) { setStatus('Online'); return; }
    await sendVoice(blob);
  };
  rec = mr; mr.start(250);
  form.classList.add('is-recording'); recorderEl.hidden = false; micBtn.classList.add('is-recording'); micBtn.setAttribute('aria-label', 'Stop recording');
  setStatus('Listening…', true); draw();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(blob); });
}

async function sendVoice(blob) {
  busy = true; autosize(); setStatus(`${store.assistantName} is thinking…`, true);
  const userMsg = addMessage('user', '…', { meta: `${icons.mic} Voice` });
  const { li, bubble } = typingBubble();
  try {
    const res = await fetch(API + '/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, audio: await blobToBase64(blob), mimeType: blob.type, messages: chatLog.slice(-24) }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    userMsg.bubble.textContent = data.transcript || '(inaudible)';
    chatLog.push({ role: 'user', content: data.transcript }, { role: 'assistant', content: data.reply });
    saveLog();
    bubble.innerHTML = fmtText(data.reply);
    const meta = document.createElement('div');
    meta.className = 'msg__meta';
    meta.innerHTML = `${icons.speaker} Spoken reply · <button class="replay" type="button">Play again</button>`;
    li.appendChild(meta);
    for (const ev of data.events || []) handleEvent(ev, li);
    const url = `data:${data.audioType || 'audio/mpeg'};base64,${data.audio}`;
    meta.querySelector('.replay').addEventListener('click', () => playSpeech(url));
    scrollDown();
    await playSpeech(url);
  } catch (err) {
    if (userMsg.bubble.textContent === '…') userMsg.li.remove();
    li.classList.add('msg--error'); bubble.textContent = `Sorry — ${err.message}`;
  } finally {
    busy = false; autosize(); setStatus('Online');
  }
}

let current = null;
function stopPlayback() { if (current) { current.audio.pause(); current.done(); } }
function playSpeech(url) {
  stopPlayback();
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let ac, raf;
    const done = () => { cancelAnimationFrame(raf); character?.setSpeaking(0); speakingBadge.hidden = true; ac?.close(); current = null; setStatus('Online'); resolve(); };
    current = { audio, done };
    try {
      ac = new AudioContext();
      const src = ac.createMediaElementSource(audio);
      const an = ac.createAnalyser(); an.fftSize = 512;
      src.connect(an); an.connect(ac.destination);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
        character?.setSpeaking(Math.min(1, Math.sqrt(s / buf.length) * 5));
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
    audio.onended = done; audio.onerror = done;
    speakingBadge.hidden = false; setStatus('Speaking…', true);
    audio.play().catch(done);
  });
}

// ================================================================ call me
const dialog = $('callDialog'), callForm = $('callForm'), callError = $('callError'), callSubmit = $('callSubmit');
function openCallDialog() {
  dialog.classList.remove('is-calling'); $('callingState').hidden = true; callError.hidden = true;
  dialog.showModal(); callForm.firstName.focus();
}
$('callFab').addEventListener('click', openCallDialog);
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
function normalizePhone(raw) {
  let p = raw.replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = p.length === 10 ? '+1' + p : '+' + p;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
callForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return dialog.close();
  callError.hidden = true;
  const f = callForm;
  f.querySelectorAll('input').forEach((i) => i.classList.remove('is-invalid'));
  const phone = normalizePhone(f.phone.value);
  const bad = [];
  if (!f.firstName.value.trim()) bad.push(f.firstName);
  if (!f.lastName.value.trim()) bad.push(f.lastName);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) bad.push(f.email);
  if (!phone) bad.push(f.phone);
  if (bad.length || !f.consent.checked) {
    bad.forEach((i) => i.classList.add('is-invalid'));
    callError.textContent = !f.consent.checked && !bad.length ? 'Please confirm you agree to receive the call.' : 'Please check the highlighted fields. Include your country code, e.g. +1 416 555 0123.';
    callError.hidden = false; bad[0]?.focus();
    return;
  }
  callSubmit.disabled = true; callSubmit.querySelector('.btn__label').textContent = 'Connecting…';
  try {
    const res = await fetch(API + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: f.firstName.value.trim(), lastName: f.lastName.value.trim(), email: f.email.value.trim(), phone }) });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error || 'Could not start the call.');
    $('callingText').textContent = `We’re calling ${phone}. Pick up and ask anything.`;
    dialog.classList.add('is-calling'); $('callingState').hidden = false;
  } catch (err) { callError.textContent = err.message; callError.hidden = false; }
  finally { callSubmit.disabled = false; callSubmit.querySelector('.btn__label').textContent = 'Call me now'; }
});

// ================================================================ boot
(async () => {
  const [info, c] = await Promise.all([
    fetch(API + '/api/store').then((r) => r.json()).catch(() => null),
    fetch(`${API}/api/cart?sid=${encodeURIComponent(sid)}`).then((r) => r.json()).catch(() => null),
  ]);
  if (info) Object.assign(store, info);
  if (store.knowledgeOnly && !store.remoteCatalog) { bagBtn.hidden = true; bagBtn.style.display = 'none'; }
  document.querySelectorAll('[data-assistant-name]').forEach((n) => (n.textContent = store.assistantName));
  document.querySelectorAll('[data-store-name]').forEach((n) => (n.textContent = store.storeName));
  if (c?.cart) setCart(c.cart); else renderBag();
  bagBtn.classList.remove('bump');
  autosize();
})();
