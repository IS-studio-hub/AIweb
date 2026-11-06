// Carts, orders, store settings and payments.
import crypto from 'node:crypto';
import { jsonStore } from './db.js';
import { getProduct, findVariant, decrementStock, allProducts, shopifyOrigin } from './catalog.js';
const nameOfId = async (id) => (await getProduct(id))?.name || id;

// ---------------------------------------------------------------- settings (editable in /admin)
export const settingsStore = jsonStore('settings.json', {
  storeName: 'FARQ',
  assistantName: 'Max',
  currency: 'CAD',
  flatShipping: 0,
  freeShippingOver: 0,
  taxRate: 0,
  about: `FARQ is a Canadian men's skincare brand built for skin over 35. A four-product AM/PM routine built on maintenance, not correction. Formulated and filled in Toronto. Tagline: "Face your future." Philosophy: "Aging isn't the enemy, neglect is." Men's skin holds its structure longer, but loses it faster: male collagen decline accelerates sharply after 35, compounded by the daily stress shaving puts on the face. FARQ is formulated specifically for men, to nourish, protect and revitalize male skin. The routine: two minutes, twice a day, every day.
Every key ingredient is chosen from ingredients with third-party, peer-reviewed research behind them, used at the concentrations those studies support.
Product claims: fragrance-free, paraben-free, phthalate-free, cruelty-free, hypoallergenic, made in Canada, dermatologist tested, clinically studied ingredients.
Founders: a family project. Co-founder John Farquhar leads the business, Cindy oversees operations, Mackenzie heads product, Taylor leads the brand. Why: men were being left to figure out skincare on their own; routines were complicated and there wasn't a straightforward system built for men's skin. Shared belief: maintenance beats repair.
Morning (AM): 001 Antioxidant Formula, then 002 Active Barrier Moisturizer. Evening (PM): 003 Reset Cleanser, then 004 Recovery Moisturizer.
Kits are subscriptions: The Full Kit from $198 per 3 months; The AM Kit from $108 per 3 months; The PM Kit from $108 per 3 months.`,
  policies: 'Shipping costs, delivery times, subscription management (pause/cancel) and the return policy have not been added yet. If a customer asks, say the team will confirm those details by email after the order.',
  contact: 'Not set yet – offer to take the question and say the team will follow up by email.',
  payOnDelivery: true,
});
export const settings = () => {
  const s = settingsStore.get();
  const cur = (process.env.STORE_CURRENCY || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(cur) ? { ...s, currency: cur } : s;
};

export const money = (n, cur = settings().currency) =>
  new Intl.NumberFormat(cur === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency: cur }).format(n);

// ---------------------------------------------------------------- carts (per browser session)
const carts = jsonStore('carts.json', {});
const MAX_QTY = 10;

export async function cartView(sid) {
  const raw = carts.get()[sid]?.lines || [];
  const lines = [];
  for (const l of raw) {
    const p = await getProduct(l.productId);
    const v = p?.variants.find((x) => x.id === l.variantId);
    if (!p || !v) continue;
    const price = v.price ?? p.price;
    lines.push({
      lineId: l.lineId, productId: p.id, variantId: v.id, name: p.name,
      size: v.size, color: v.color, qty: l.qty, price, lineTotal: price * l.qty,
      image: p.images[0] || null, stock: v.stock, sample: p.sample,
    });
  }
  const s = settings();
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  const shopify = !!shopifyOrigin();
  const shipping = shopify || !lines.length ? 0 : subtotal >= s.freeShippingOver ? 0 : s.flatShipping;
  const tax = shopify ? 0 : Math.round(subtotal * (s.taxRate || 0)) / 100;
  return {
    externalCheckout: shopify,
    lines, count: lines.reduce((a, l) => a + l.qty, 0),
    subtotal, shipping, tax, total: subtotal + shipping + tax, currency: s.currency,
    freeShippingOver: shopify ? 0 : s.freeShippingOver,
    toFreeShipping: !shopify && lines.length && subtotal < s.freeShippingOver ? s.freeShippingOver - subtotal : 0,
  };
}

export async function addToCart(sid, { productId, size, color, variantId, qty = 1 }) {
  const p = await getProduct(productId);
  if (!p || !p.active) return { ok: false, error: 'Product not found.' };
  if (p.notForSale) return { ok: false, error: `${p.name} isn’t sold on its own – it comes in: ${(await Promise.all(p.availableIn.map(nameOfId))).join(' or ')}.`, availableIn: p.availableIn };
  const v = findVariant(p, { size, color, variantId });
  if (!v) {
    const need = [p.sizes.length && !size ? `size (${p.sizes.join(', ')})` : '', p.colors.length > 1 && !color ? `colour (${p.colors.join(', ')})` : ''].filter(Boolean).join(' and ');
    return { ok: false, error: need ? `Please choose a ${need}.` : 'That option is not available.' };
  }
  const c = carts.get()[sid] || { lines: [] };
  const existing = c.lines.find((l) => l.variantId === v.id);
  const want = Math.min(MAX_QTY, (existing?.qty || 0) + Math.max(1, Math.floor(qty)));
  if (v.stock <= 0) return { ok: false, error: `${p.name}${v.size ? ' in ' + v.size : ''} is sold out.` };
  const finalQty = Math.min(want, v.stock);
  if (existing) existing.qty = finalQty;
  else c.lines.push({ lineId: crypto.randomUUID().slice(0, 8), productId: p.id, variantId: v.id, qty: finalQty });
  carts.get()[sid] = { ...c, updatedAt: Date.now() };
  carts.touch();
  return { ok: true, limited: finalQty < want, cart: await cartView(sid) };
}

export async function updateCartLine(sid, lineId, qty) {
  const c = carts.get()[sid];
  if (!c) return cartView(sid);
  const l = c.lines.find((x) => x.lineId === lineId);
  if (l) {
    if (qty <= 0) c.lines = c.lines.filter((x) => x !== l);
    else l.qty = Math.min(MAX_QTY, Math.floor(qty));
  }
  carts.touch();
  return cartView(sid);
}

export function clearCart(sid) { delete carts.get()[sid]; carts.touch(); }

// Drop carts idle for 30 days.
setInterval(() => {
  const cutoff = Date.now() - 30 * 864e5;
  const all = carts.get();
  for (const k of Object.keys(all)) if ((all[k].updatedAt || 0) < cutoff) delete all[k];
  carts.touch();
}, 6 * 3600e3).unref();

// ---------------------------------------------------------------- orders
export const ordersStore = jsonStore('orders.json', { nextNumber: 1001, orders: [] });
export const ORDER_STATUSES = ['new', 'processing', 'shipped', 'delivered', 'cancelled'];

const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);

export function validateCheckout(body) {
  const c = body.customer || {}, a = body.address || {};
  const customer = { name: clean(c.name, 120), email: clean(c.email, 160), phone: clean(c.phone, 40) };
  const address = {
    line1: clean(a.line1), line2: clean(a.line2), city: clean(a.city, 80),
    region: clean(a.region, 80), postal: clean(a.postal, 20), country: clean(a.country, 60),
  };
  const errors = [];
  if (!customer.name) errors.push('name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) errors.push('email');
  if (!address.line1) errors.push('address');
  if (!address.city) errors.push('city');
  if (!address.postal) errors.push('postal code');
  if (!address.country) errors.push('country');
  return { customer, address, errors };
}

export async function createOrder(sid, { customer, address, paymentMethod, note }) {
  const cart = await cartView(sid);
  if (!cart.lines.length) return { ok: false, error: 'Your bag is empty.' };
  for (const l of cart.lines) {
    if (l.qty > l.stock) return { ok: false, error: `Only ${l.stock} left of ${l.name}${l.size ? ' (' + l.size + ')' : ''}. Please update your bag.` };
  }
  const order = ordersStore.update((db) => {
    const o = {
      id: `FARQ-${db.nextNumber++}`,
      token: crypto.randomBytes(12).toString('hex'),
      createdAt: new Date().toISOString(),
      status: 'new',
      customer, address, note: clean(note, 500),
      items: cart.lines.map(({ productId, variantId, name, size, color, qty, price, image, sample }) => ({ productId, variantId, name, size, color, qty, price, image, sample })),
      subtotal: cart.subtotal, shipping: cart.shipping, tax: cart.tax, total: cart.total, currency: cart.currency,
      payment: { method: paymentMethod, status: 'pending' },
      tracking: null,
      history: [{ at: new Date().toISOString(), status: 'new', note: 'Order placed in chat' }],
      source: 'chat',
    };
    db.orders.unshift(o);
    return o;
  });
  decrementStock(cart.lines);
  clearCart(sid);
  return { ok: true, order };
}

export function getOrder(id) { return ordersStore.get().orders.find((o) => o.id === id) || null; }

export function updateOrder(id, patch) {
  return ordersStore.update((db) => {
    const o = db.orders.find((x) => x.id === id);
    if (!o) return null;
    const notes = [];
    if (patch.status && ORDER_STATUSES.includes(patch.status) && patch.status !== o.status) {
      o.status = patch.status; notes.push(`Status → ${patch.status}`);
    }
    if (patch.paymentStatus && ['pending', 'paid', 'refunded'].includes(patch.paymentStatus) && patch.paymentStatus !== o.payment.status) {
      o.payment.status = patch.paymentStatus; notes.push(`Payment → ${patch.paymentStatus}`);
    }
    if (patch.tracking) {
      o.tracking = { carrier: clean(patch.tracking.carrier, 60), number: clean(patch.tracking.number, 80), url: clean(patch.tracking.url, 300) };
      notes.push(`Tracking: ${o.tracking.carrier} ${o.tracking.number}`.trim());
    }
    if (patch.internalNote) notes.push(clean(patch.internalNote, 500));
    if (notes.length) o.history.push({ at: new Date().toISOString(), status: o.status, note: notes.join(' · ') });
    return o;
  });
}

/** What a shopper may see about their order. */
export const publicOrder = (o) => o && ({
  id: o.id, status: o.status, createdAt: o.createdAt, total: o.total, currency: o.currency,
  items: o.items.map(({ name, size, color, qty, price, image }) => ({ name, size, color, qty, price, image })),
  payment: { method: o.payment.method, status: o.payment.status },
  tracking: o.tracking, shipTo: `${o.address.city}, ${o.address.country}`,
});

export async function salesSummary() {
  const orders = ordersStore.get().orders;
  const live = orders.filter((o) => o.status !== 'cancelled');
  const since = (d) => live.filter((o) => Date.now() - Date.parse(o.createdAt) < d * 864e5);
  const sum = (arr) => arr.reduce((a, o) => a + o.total, 0);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, orders.filter((o) => o.status === s).length]));
  const top = {};
  for (const o of live) for (const i of o.items) top[i.name] = (top[i.name] || 0) + i.qty;
  const products = await allProducts({ includeInactive: true });
  const lowStock = products.flatMap((p) => p.variants.filter((v) => v.stock <= 3).map((v) => ({ product: p.name, variant: [v.color, v.size].filter(Boolean).join(' / '), stock: v.stock })));
  return {
    currency: settings().currency,
    revenue: { today: sum(since(1)), week: sum(since(7)), all: sum(live) },
    orders: { today: since(1).length, week: since(7).length, all: live.length },
    toShip: orders.filter((o) => o.status === 'new' || o.status === 'processing').length,
    counts,
    topProducts: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty })),
    lowStock: lowStock.slice(0, 12),
  };
}

// ---------------------------------------------------------------- Stripe (optional – card payments)
const STRIPE_KEY = () => (process.env.STRIPE_SECRET_KEY || '').trim();
export const stripeEnabled = () => !!STRIPE_KEY();

function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') formEncode(v, key, out);
    else if (v !== undefined && v !== null) out.append(key, String(v));
  }
  return out;
}
async function stripe(path, method = 'GET', body) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_KEY()}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? formEncode(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Stripe error ${r.status}`);
  return j;
}

export async function createStripeSession(order, origin) {
  const cur = order.currency.toLowerCase();
  const line_items = {};
  order.items.forEach((i, n) => {
    line_items[n] = { quantity: i.qty, price_data: { currency: cur, unit_amount: Math.round(i.price * 100), product_data: { name: [i.name, i.color, i.size].filter(Boolean).join(' · ') } } };
  });
  let n = order.items.length;
  if (order.shipping > 0) line_items[n++] = { quantity: 1, price_data: { currency: cur, unit_amount: Math.round(order.shipping * 100), product_data: { name: 'Shipping' } } };
  if (order.tax > 0) line_items[n++] = { quantity: 1, price_data: { currency: cur, unit_amount: Math.round(order.tax * 100), product_data: { name: 'Tax' } } };
  const s = await stripe('checkout/sessions', 'POST', {
    mode: 'payment',
    line_items,
    customer_email: order.customer.email,
    client_reference_id: order.id,
    metadata: { order_id: order.id },
    success_url: `${origin}/?order=${encodeURIComponent(order.id)}&t=${order.token}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?order=${encodeURIComponent(order.id)}&t=${order.token}&cancelled=1`,
  });
  ordersStore.update((db) => { const o = db.orders.find((x) => x.id === order.id); if (o) o.payment.stripeSession = s.id; });
  return s.url;
}

export async function confirmStripe(orderId, token, sessionId) {
  const o = getOrder(orderId);
  if (!o || o.token !== token) return null;
  if (o.payment.status !== 'paid' && sessionId && o.payment.stripeSession === sessionId && stripeEnabled()) {
    const s = await stripe(`checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (s.payment_status === 'paid') updateOrder(o.id, { paymentStatus: 'paid', internalNote: 'Paid by card (Stripe)' });
  }
  return getOrder(orderId);
}

// ---------------------------------------------------------------- Shopify checkout hand-off
/** Shopify "cart permalink": opens the store's real checkout with these items in the cart. */
export async function externalCheckoutUrl(sid) {
  const origin = shopifyOrigin();
  if (!origin) return null;
  const c = await cartView(sid);
  if (!c.lines.length) return null;
  return `${origin}/cart/${c.lines.map((l) => `${encodeURIComponent(l.variantId)}:${l.qty}`).join(',')}`;
}
