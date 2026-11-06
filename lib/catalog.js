// Product catalog.
//  • Default: local file data/products.json (edit it in the admin dashboard).
//  • Later: set CATALOG_API_URL in .env and products are read from your API instead
//    (GET → JSON array of products, or { products: [...] }, in the shape documented below).
//
// Product shape
// {
//   id, name, category, description, highlights: [string], tags: [string],
//   price: number, compareAtPrice?: number, images: [url],
//   colors?: [string], sizes?: [string],
//   variants: [{ id, color?, size?, stock: number, price?: number }],
//   active: boolean, sample?: boolean
// }
import { jsonStore, uid } from './db.js';
import { SAMPLE_PRODUCTS } from './sample-products.js';

const local = jsonStore('products.json', SAMPLE_PRODUCTS);
const API = (process.env.CATALOG_API_URL || '').trim();
const API_KEY = (process.env.CATALOG_API_KEY || '').trim();
let apiCache = { at: 0, items: [] };

export const usingRemoteCatalog = () => !!API;

function normalize(p) {
  const sizes = p.sizes || [...new Set((p.variants || []).map((v) => v.size).filter(Boolean))];
  const colors = p.colors || [...new Set((p.variants || []).map((v) => v.color).filter(Boolean))];
  let variants = (p.variants || []).map((v) => ({
    id: String(v.id ?? uid('v_')), color: v.color || null, size: v.size || null,
    stock: Number.isFinite(+v.stock) ? +v.stock : 99, price: v.price != null ? +v.price : null,
  }));
  if (!variants.length) variants = [{ id: `${p.id}-default`, color: null, size: null, stock: Number.isFinite(+p.stock) ? +p.stock : 99, price: null }];
  return {
    id: String(p.id),
    name: String(p.name || p.title || 'Product'),
    category: p.category || p.product_type || '',
    description: p.description || '',
    highlights: p.highlights || [],
    tags: p.tags || [],
    price: +p.price || 0,
    compareAtPrice: p.compareAtPrice ? +p.compareAtPrice : null,
    images: (p.images || []).map((i) => (typeof i === 'string' ? i : i.src || i.url)).filter(Boolean),
    sizes, colors, variants,
    active: p.active !== false,
    sample: !!p.sample,
    url: p.url || '',
    priceNote: p.priceNote || '',
    notForSale: !!p.notForSale,
    availableIn: Array.isArray(p.availableIn) ? p.availableIn.map(String) : [],
    includes: Array.isArray(p.includes) ? p.includes.map(String) : [],
  };
}

// ---------------------------------------------------------------- remote catalog (your API or a Shopify store)
// Shopify: set CATALOG_API_URL=https://yourstore.com/products.json – the public product feed
// (titles, photos, prices, colours/sizes, availability). Pages are fetched automatically.
const isShopifyProduct = (p) => p && p.handle && Array.isArray(p.variants) && 'body_html' in p;
export const shopifyOrigin = () => { try { return /products\.json/.test(API) ? new URL(API).origin : ''; } catch { return ''; } };

const stripHtml = (h) => String(h || '').replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&[a-z]+;/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

function fromShopify(p, origin) {
  const opts = (p.options || []).map((o) => String(o.name || '').toLowerCase());
  const ci = opts.findIndex((n) => /colou?r/.test(n));
  const si = opts.findIndex((n, i) => i !== ci && n && n !== 'title');
  const val = (v, i) => (i >= 0 ? v[`option${i + 1}`] || null : null);
  const variants = p.variants.map((v) => ({
    id: String(v.id), color: val(v, ci), size: val(v, si) === 'Default Title' ? null : val(v, si),
    stock: v.available === false ? 0 : 99, price: v.price != null ? +v.price : null,
    compareAt: v.compare_at_price ? +v.compare_at_price : null,
  }));
  const prices = variants.map((v) => v.price).filter((x) => x != null);
  const price = prices.length ? Math.min(...prices) : null;
  const cmp = variants.map((v) => v.compareAt).filter(Boolean);
  return {
    id: String(p.handle),
    name: p.title,
    category: p.product_type || '',
    description: stripHtml(p.body_html).slice(0, 1500),
    highlights: [],
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    price,
    compareAtPrice: cmp.length && Math.max(...cmp) > (price || 0) ? Math.max(...cmp) : null,
    images: (p.images || []).map((i) => i.src).filter(Boolean),
    colors: [...new Set(variants.map((v) => v.color).filter(Boolean))],
    sizes: [...new Set(variants.map((v) => v.size).filter(Boolean))],
    variants: variants.map(({ compareAt, ...v }) => v),
    url: origin ? `${origin}/products/${p.handle}` : '',
    active: variants.some((v) => v.stock > 0) || true,
  };
}

async function fetchRemoteCatalog() {
  const headers = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
  const origin = shopifyOrigin();
  const all = [];
  for (let page = 1; page <= 8; page++) {
    const u = new URL(API);
    if (origin) {
      u.searchParams.set('limit', '250'); u.searchParams.set('page', String(page));
      // Shopify converts prices to the requester's local currency – ask for the store's currency.
      const cur = (process.env.STORE_CURRENCY || '').trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(cur)) u.searchParams.set('currency', cur);
    }
    const r = await fetch(u, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const list = Array.isArray(j) ? j : j.products || [];
    all.push(...list);
    if (!origin || list.length < 250) break;
  }
  return all.map((p) => (isShopifyProduct(p) ? normalize(fromShopify(p, origin)) : normalize(p)));
}

export async function allProducts({ includeInactive = false } = {}) {
  let items;
  if (API) {
    if (Date.now() - apiCache.at > 60_000) {
      try {
        apiCache = { at: Date.now(), items: await fetchRemoteCatalog() };
      } catch (e) {
        console.error('[catalog] API error:', e.message);
      }
    }
    items = apiCache.items;
  } else {
    items = local.get().map(normalize);
  }
  return includeInactive ? items : items.filter((p) => p.active);
}

export async function getProduct(id) {
  return (await allProducts({ includeInactive: true })).find((p) => p.id === String(id)) || null;
}

export const stockOf = (p) => p.variants.reduce((a, v) => a + Math.max(0, v.stock), 0);

export function findVariant(p, { size, color, variantId } = {}) {
  if (variantId) return p.variants.find((v) => v.id === String(variantId)) || null;
  const eq = (a, b) => !b || !a || String(a).toLowerCase() === String(b).toLowerCase();
  const matches = p.variants.filter((v) => eq(v.size, size) && eq(v.color, color));
  if (p.sizes.length && !size) return null;     // must choose a size
  if (p.colors.length > 1 && !color) return null; // must choose a colour
  return matches[0] || null;
}

export async function searchProducts({ query = '', category, maxPrice } = {}) {
  const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  return (await allProducts())
    .filter((p) => !category || p.category.toLowerCase().includes(String(category).toLowerCase()))
    .filter((p) => !maxPrice || p.price <= +maxPrice)
    .map((p) => {
      const hay = [p.name, p.category, p.description, ...p.tags, ...p.colors, ...p.highlights].join(' ').toLowerCase();
      return { p, score: words.length ? words.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0) : 1 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}

/** Admin editing (local catalog only). */
export const catalogStore = local;

export function decrementStock(lines) {
  if (API) return; // your API owns stock
  local.update((list) => {
    for (const l of lines) {
      const p = list.find((x) => String(x.id) === l.productId);
      const v = p?.variants?.find((x) => String(x.id) === l.variantId);
      if (v && Number.isFinite(+v.stock)) v.stock = Math.max(0, v.stock - l.qty);
    }
  });
}
