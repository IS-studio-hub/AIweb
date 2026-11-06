// The in-store sales associate: system prompt, tools and the tool-calling loop.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamChat } from './ai.js';
import { allProducts, getProduct, searchProducts, stockOf, usingRemoteCatalog } from './catalog.js';
import { askKnowledge, knowledgeEnabled, KNOWLEDGE_TOOL_DESCRIPTION } from './knowledge.js';
import { settings, cartView, addToCart, updateCartLine, getOrder, publicOrder, money, stripeEnabled, externalCheckoutUrl } from './commerce.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = path.join(ROOT, 'config', 'assistant-prompt.md');
const readPrompt = () => { try { return fs.readFileSync(PROMPT_FILE, 'utf8'); } catch { return ''; } };

// ---------------------------------------------------------------- catalog digest for the prompt
export async function catalogDigest() {
  const s = settings();
  const items = await allProducts();
  const lines = items.slice(0, 60).map((p) => {
    const stock = stockOf(p);
    const sizes = p.sizes.length ? ` | sizes: ${p.sizes.join('/')}` : '';
    const colors = p.colors.length ? ` | colours: ${p.colors.join('/')}` : '';
    const sale = p.compareAtPrice && p.compareAtPrice > p.price ? ` (was ${money(p.compareAtPrice)})` : '';
    const low = p.variants.filter((v) => v.stock > 0 && v.stock <= 3).map((v) => [v.color, v.size].filter(Boolean).join(' ') || 'item');
    const priceText = p.notForSale ? `not sold separately – comes in: ${p.availableIn.join(', ')}` : `${money(p.price)}${p.priceNote ? ' ' + p.priceNote : ''}${sale}`;
    const inc = p.includes.length ? ` | includes: ${p.includes.join(', ')}` : '';
    const stockText = p.notForSale ? '' : ` | ${stock > 0 ? 'in stock' : 'SOLD OUT'}${low.length ? ` | low stock: ${low.join(', ')}` : ''}`;
    return `- [${p.id}] ${p.name} — ${p.category} — ${priceText}${colors}${sizes}${inc}${stockText}\n    ${p.description}${p.highlights.length ? ' Key points: ' + p.highlights.join('; ') + '.' : ''}`;
  });
  const demo = items.some((p) => p.sample);
  return { text: lines.join('\n') + (items.length > 60 ? `\n…and ${items.length - 60} more (use search_products).` : ''), demo, currency: s.currency };
}

export async function systemPrompt(sid, mode) {
  const s = settings();
  const cat = await catalogDigest();
  const cart = await cartView(sid);
  const cartText = cart.lines.length
    ? cart.lines.map((l) => `- ${l.qty} × ${l.name}${l.color ? ' / ' + l.color : ''}${l.size ? ' / ' + l.size : ''} — ${money(l.lineTotal)}`).join('\n') +
      `\nSubtotal ${money(cart.subtotal)}${cart.toFreeShipping ? ` — ${money(cart.toFreeShipping)} away from free shipping` : ' — qualifies for free shipping'}`
    : '(empty)';
  return [
    readPrompt().replaceAll('{{assistantName}}', s.assistantName).replaceAll('{{storeName}}', s.storeName),
    `\n## Store facts (the ONLY facts you may state about the store)\nAbout: ${s.about}\nPolicies:\n${s.policies}\nContact: ${s.contact}\nCurrency: ${s.currency}. Shipping: ${money(s.flatShipping)} flat, free on orders over ${money(s.freeShippingOver)}.` +
      `\nPayment options at checkout: ${[stripeEnabled() && 'card (secure Stripe checkout)', s.payOnDelivery && 'pay on delivery / pay later'].filter(Boolean).join(', ') || 'pay later'}.`,
    `\n## Catalog (live, ${cat.currency})\n${cat.text}${cat.demo ? '\nNOTE: items marked sample are placeholder demo products; if the shopper asks whether they are real, say this is a demo catalog.' : ''}`,
    `\n## This shopper's bag\n${cartText}`,
    knowledgeEnabled()
      ? "\n## FARQ knowledge base (ask_farq_knowledge)\nYou have a tool connected to FARQ's own knowledge base, built from FARQ's website and brand data. For any factual question about FARQ (ingredients, how to use, routine, skin concerns, brand, subscriptions, shipping, returns, FAQs) that the catalog and store facts above don't fully answer, call ask_farq_knowledge first and base your answer on what it returns, in your own words and sales voice. Rules: the live catalog wins on price, availability and what can be bought; never invent facts it didn't give you; if it can't answer or is unavailable, say you'll have the team confirm. Don't mention the tool or 'knowledge base' to the shopper."
      : '',
    mode === 'voice'
      ? '\n## Channel\nThe shopper is talking to you by voice; your reply is read aloud. Speak naturally in 1–3 short sentences, no lists, no markdown, no prices with cents unless needed. Product cards still appear on their screen when you call show_products.'
      : '\n## Channel\nWebsite chat. Keep replies short and conversational (1–4 sentences). No markdown headings or tables; light **bold** is fine. Product cards with photos appear when you call show_products — don\'t repeat every detail the card already shows.',
  ].join('\n');
}

// ---------------------------------------------------------------- tools
const KNOWLEDGE_TOOL = {
  type: 'function', function: {
    name: 'ask_farq_knowledge',
    description: KNOWLEDGE_TOOL_DESCRIPTION,
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
};

export const TOOLS = [
  {
    type: 'function', function: {
      name: 'search_products',
      description: 'Search the catalog by keywords (style, occasion, colour, item type), optional category and max price.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' }, max_price: { type: 'number' } } },
    },
  },
  {
    type: 'function', function: {
      name: 'get_product_details',
      description: 'Full details for one product: description, highlights, sizes, colours, per-variant stock.',
      parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
    },
  },
  {
    type: 'function', function: {
      name: 'show_products',
      description: 'Display product cards (photo, price, sizes, Add-to-bag button) in the chat. Use whenever you recommend or mention specific products. Max 4 per call, best first.',
      parameters: { type: 'object', properties: { product_ids: { type: 'array', items: { type: 'string' } } }, required: ['product_ids'] },
    },
  },
  {
    type: 'function', function: {
      name: 'show_catalog',
      description: 'Display MANY products at once in a scrollable grid (photo, price, Add-to-bag). Use when the shopper wants to see all products, the whole collection/catalog, everything in a category, or "all hoodies", "everything for kids", etc. Leave filter empty for the full catalog. The grid shows every match – you don\'t need to know product ids.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional keyword(s) matched against product name, category, colours and description, e.g. "hoodie", "kids", "hat". Empty = all products.' },
          in_stock_only: { type: 'boolean', description: 'Hide sold-out items. Default false.' },
        },
      },
    },
  },
  {
    type: 'function', function: {
      name: 'add_to_cart',
      description: 'Add an item to the shopper\'s bag. Only call after the shopper agreed to buy/add it and the required size/colour is known.',
      parameters: {
        type: 'object',
        properties: { product_id: { type: 'string' }, size: { type: 'string' }, color: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['product_id'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'update_cart_item',
      description: 'Change the quantity of a bag line (0 removes it). Use line_id from the bag.',
      parameters: { type: 'object', properties: { line_id: { type: 'string' }, quantity: { type: 'integer', minimum: 0, maximum: 10 } }, required: ['line_id', 'quantity'] },
    },
  },
  {
    type: 'function', function: {
      name: 'view_cart',
      description: 'Get the shopper\'s bag (with line ids) and show it to them.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'start_checkout',
      description: 'Open the secure checkout form in the chat (contact, shipping address, payment). Call when the shopper is ready to buy.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'check_order_status',
      description: 'Look up an existing order. Requires the order number (e.g. FARQ-1001) and the email used for the order.',
      parameters: { type: 'object', properties: { order_id: { type: 'string' }, email: { type: 'string' } }, required: ['order_id', 'email'] },
    },
  },
];

const cardOf = (p) => ({
  id: p.id, name: p.name, category: p.category, price: p.price, compareAtPrice: p.compareAtPrice,
  images: p.images, sizes: p.sizes, colors: p.colors, description: p.description, highlights: p.highlights,
  variants: p.variants.map((v) => ({ id: v.id, size: v.size, color: v.color, stock: v.stock })), sample: p.sample,
  priceNote: p.priceNote, notForSale: p.notForSale, availableIn: p.availableIn, includes: p.includes, url: p.url,
});

async function runTool(name, args, ctx) {
  switch (name) {
    case 'search_products': {
      const r = await searchProducts({ query: args.query, category: args.category, maxPrice: args.max_price });
      return { results: r.slice(0, 8).map((p) => ({ id: p.id, name: p.name, category: p.category, price: p.price, colors: p.colors, in_stock: stockOf(p) > 0 })) };
    }
    case 'get_product_details': {
      const p = await getProduct(args.product_id);
      if (!p) return { error: 'Not found' };
      return { ...cardOf(p), images: undefined, image_count: p.images.length };
    }
    case 'show_products': {
      const ids = (args.product_ids || []).slice(0, 4);
      const ps = (await Promise.all(ids.map(getProduct))).filter((p) => p && p.active);
      const all = await allProducts();
      const nameOf = (id) => all.find((x) => x.id === id)?.name || id;
      if (ps.length) ctx.emit({ t: 'products', items: ps.map((p) => ({ ...cardOf(p), availableInNames: p.availableIn.map(nameOf), includesNames: p.includes.map(nameOf) })) });
      return { shown: ps.map((p) => p.name) };
    }
    case 'show_catalog': {
      const all = (await allProducts()).filter((p) => p.active !== false);
      const words = String(args.filter || '').toLowerCase().split(/[\s,]+/).filter((w) => w && !['all', 'the', 'products', 'product', 'items', 'everything', 'catalog', 'collection'].includes(w));
      const hay = (p) => [p.name, p.category, p.colors.join(' '), p.description].join(' ').toLowerCase();
      const stem = (w) => w.replace(/(es|s)$/, '');
      let list = words.length ? all.filter((p) => words.every((w) => hay(p).includes(stem(w)))) : all;
      if (args.in_stock_only) list = list.filter((p) => p.notForSale || stockOf(p) > 0);
      if (list.length) ctx.emit({ t: 'products', layout: 'grid', title: words.length ? `“${args.filter}”` : 'All products', items: list.map((p) => ({ ...cardOf(p), availableInNames: [], includesNames: [] })) });
      const cats = [...new Set(all.map((p) => p.category).filter(Boolean))].slice(0, 30);
      return { shown_in_grid: list.length, total_products: all.length, categories: cats };
    }
    case 'add_to_cart': {
      const r = await addToCart(ctx.sid, { productId: args.product_id, size: args.size, color: args.color, qty: args.quantity || 1 });
      if (r.ok) ctx.emit({ t: 'cart', cart: r.cart, added: true });
      return r.ok ? { ok: true, limited_by_stock: r.limited, bag: summarizeCart(r.cart) } : r;
    }
    case 'update_cart_item': {
      const cart = await updateCartLine(ctx.sid, args.line_id, args.quantity);
      ctx.emit({ t: 'cart', cart });
      return { bag: summarizeCart(cart) };
    }
    case 'view_cart': {
      const cart = await cartView(ctx.sid);
      ctx.emit({ t: 'cart', cart, show: true });
      return { bag: summarizeCart(cart) };
    }
    case 'start_checkout': {
      const cart = await cartView(ctx.sid);
      if (!cart.lines.length) return { error: 'The bag is empty — add something first.' };
      const ext = await externalCheckoutUrl(ctx.sid);
      if (ext) {
        ctx.emit({ t: 'checkout', url: ext });
        return { ok: true, note: "A 'Go to secure checkout' button is now in the chat; it opens the store's own checkout with the bag already filled in (shipping and payment are entered there). Tell them briefly." };
      }
      ctx.emit({ t: 'checkout' });
      return { ok: true, note: 'Checkout form is now open on the shopper\'s screen. Tell them briefly; do not ask for card details in chat.' };
    }
    case 'ask_farq_knowledge': {
      ctx.emit({ t: 'status', text: 'Checking…' });
      const r = await askKnowledge(args.question);
      return r.ok ? { answer: r.answer, sources: r.sources } : { unavailable: true, note: r.error + ' Answer from the catalog and store facts only, or offer to have the team confirm.' };
    }
    case 'check_order_status': {
      const o = getOrder(String(args.order_id || '').toUpperCase().trim());
      if (!o || o.customer.email.toLowerCase() !== String(args.email || '').toLowerCase().trim()) return { error: 'No order found with that number and email.' };
      const po = publicOrder(o);
      ctx.emit({ t: 'order', order: po });
      return po;
    }
    default:
      return { error: 'Unknown tool' };
  }
}

const summarizeCart = (c) => ({
  lines: c.lines.map((l) => ({ line_id: l.lineId, name: l.name, size: l.size, color: l.color, qty: l.qty, line_total: l.lineTotal })),
  subtotal: c.subtotal, shipping: c.shipping, total: c.total, away_from_free_shipping: c.toFreeShipping,
});

// ---------------------------------------------------------------- conversation loop
const clip = (s, n) => String(s ?? '').slice(0, n);

export function cleanHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-24)
    .map((m) => ({ role: m.role, content: clip(m.content, 4000) }));
}

/**
 * Runs one shopper turn. `emit` receives UI events: {t:'text',d} {t:'products'} {t:'cart'} {t:'checkout'} {t:'order'}.
 * Returns the assistant's full reply text.
 */
// ---------------------------------------------------------------- knowledge-only mode
// KNOWLEDGE_ONLY=true in .env: OpenAI still writes every reply, but the ONLY source of facts is
// the knowledge API (KNOWLEDGE_API_URL). The local catalog, store facts and playbook are not used.
export const knowledgeOnly = () => (process.env.KNOWLEDGE_ONLY || '').trim().toLowerCase() === 'true';
export const brandName = () => (process.env.BRAND_NAME || '').trim() || settings().storeName;

function knowledgeOnlyPrompt(mode, k, catalog = '') {
  const s = settings(), brand = brandName();
  const knowledge = k === null
    ? '(No lookup was needed for this message.)'
    : k.ok
      ? `${k.answer}${k.sources?.length ? `\n(Sources: ${k.sources.join('; ')})` : ''}`
      : 'UNAVAILABLE – the knowledge base could not be reached right now. Do not answer factual questions about the brand; briefly apologize, say you can\'t pull that up at the moment, and ask them to try again shortly (or tap the phone button to get a call).';
  return [
    `You are ${s.assistantName}, the website assistant for ${brand}. You chat with visitors in a warm, helpful, confident way.`,
    `\n# Your only source of facts\nEverything you say about ${brand} (what it is, products, services, prices, people, policies, contact details, opening hours, anything factual) must come from the "Knowledge" section below (from ${brand}'s own knowledge base)${catalog ? ' or the "Product catalog" section (live from the store)' : ''}.`,
    '- Never use outside knowledge or guesses about the brand. Never invent products, prices, offers, details or policies.',
    `- If the knowledge doesn't contain the answer, say you don't have that information and suggest they tap the phone button to talk to someone.`,
    '- You may greet, make small talk, ask what they need and help them find their way without using facts.',
    '- Don\'t mention "knowledge base", "sources" or how you got the information.',
    '- Messages starting with [event] are things the visitor did on screen; react briefly.',
    '- Reply in the visitor\'s language.',
    mode === 'voice'
      ? '\n# Channel\nThe visitor is talking by voice; your reply is read aloud. 1–3 short sentences, no lists or markdown.'
      : '\n# Channel\nWebsite chat. Short, conversational replies (1–4 sentences, light **bold** ok, no headings).',
    `\n# Knowledge for this message\n${knowledge}`,
    catalog ? `\n# Product catalog (live from the ${brand} store – the ONLY products that exist)\nProduct names, prices, colours, sizes, availability and photos come ONLY from this list and the product tools. Never invent products or prices.\n- When the visitor asks for ALL products, the whole catalog/collection, \"everything\", or a whole category (\"all hoodies\", \"kids stuff\"), call show_catalog (with a filter for a category/keyword) – it shows every match in one grid. Then reply in ONE short sentence (e.g. how many items and an offer to help narrow down) – never list the products in text, the grid already shows them.\n- When the visitor asks to see some products, what you sell, or browses, IMMEDIATELY call show_products with 4 good picks (best matches, or a varied selection if they didn't say what they want) so they see photos and prices – then ask what they're looking for. Don't ask before showing. Use search_products to find items by keyword.\n- To buy: ask for colour/size if needed, call add_to_cart, then start_checkout when they're ready (checkout happens on the store's own secure checkout).\n${catalog}` : '',
  ].join('\n');
}

async function knowledgeOnlyTurn({ sid, history, mode, emit }) {
  const last = history[history.length - 1]?.content || '';
  let k = null;
  if (!last.startsWith('[event]')) {
    emit({ t: 'status', text: 'Checking…' });
    k = await askKnowledge(last, { history: history.slice(0, -1).filter((m) => !m.content.startsWith('[event]')) });
  }
  const remote = usingRemoteCatalog();
  const catalog = remote ? (await catalogDigest()).text : '';
  const messages = [{ role: 'system', content: knowledgeOnlyPrompt(mode, k, catalog) }, ...history];
  return toolLoop({ messages, tools: remote ? TOOLS : [], sid, emit, temperature: 0.4 });
}

/** Streams the model, runs any tool calls, and repeats until it answers in text. */
async function toolLoop({ messages, tools, sid, emit, temperature }) {
  let reply = '';
  for (let round = 0; round < 6; round++) {
    let end;
    for await (const ev of streamChat({ messages, tools, temperature })) {
      if (ev.type === 'text') { reply += ev.delta; emit({ t: 'text', d: ev.delta }); }
      else end = ev;
    }
    if (!end?.toolCalls?.length) break;
    messages.push({
      role: 'assistant', content: end.text || null,
      tool_calls: end.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const c of end.toolCalls) {
      let args = {};
      try { args = JSON.parse(c.arguments || '{}'); } catch {}
      let result;
      try { result = await runTool(c.name, args, { sid, emit }); } catch (e) { result = { error: e.message }; }
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
    }
    if (reply && !reply.endsWith(' ') && !reply.endsWith('\n')) { reply += ' '; emit({ t: 'text', d: ' ' }); }
  }
  return reply.trim();
}

export async function runTurn({ sid, history, mode = 'text', emit: rawEmit }) {
  if (knowledgeOnly()) return knowledgeOnlyTurn({ sid, history, mode, emit: rawEmit });
  const messages = [{ role: 'system', content: await systemPrompt(sid, mode) }, ...history];
  let reply = '';
  let shownCards = false;
  const emit = (ev) => { if (ev.t === 'products') shownCards = true; rawEmit(ev); };
  for (let round = 0; round < 6; round++) {
    let end;
    for await (const ev of streamChat({ messages, tools: knowledgeEnabled() ? [...TOOLS, KNOWLEDGE_TOOL] : TOOLS })) {
      if (ev.type === 'text') { reply += ev.delta; emit({ t: 'text', d: ev.delta }); }
      else end = ev;
    }
    if (!end?.toolCalls?.length) {
      // Safety net: if the reply names products but no cards were shown, show them.
      if (!shownCards && reply) await autoShowMentioned(reply, emit);
      break;
    }
    if (!end?.toolCalls?.length) break;
    messages.push({
      role: 'assistant', content: end.text || null,
      tool_calls: end.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const c of end.toolCalls) {
      let args = {};
      try { args = JSON.parse(c.arguments || '{}'); } catch {}
      let result;
      try { result = await runTool(c.name, args, { sid, emit }); } catch (e) { result = { error: e.message }; }
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
    }
    if (reply && !reply.endsWith(' ') && !reply.endsWith('\n')) { reply += ' '; emit({ t: 'text', d: ' ' }); }
  }
  return reply.trim();
}

/** Finds products named in a reply (full name, or distinctive short forms like "001" / "Full Kit"). */
async function autoShowMentioned(text, emit) {
  const t = text.toLowerCase();
  const all = await allProducts();
  const hits = [];
  for (const p of all) {
    const name = p.name.toLowerCase();
    const short = name.replace(/^the\s+/, '');
    const code = (name.match(/^(\d{3})\b/) || [])[1];
    const at = [t.indexOf(name), t.indexOf(short), code ? t.search(new RegExp(`\\b${code}\\b`)) : -1].filter((i) => i >= 0);
    if (at.length) hits.push({ p, at: Math.min(...at) });
  }
  if (!hits.length) return;
  hits.sort((a, b) => a.at - b.at);
  const nameOf = (id) => all.find((x) => x.id === id)?.name || id;
  emit({ t: 'products', items: hits.slice(0, 4).map(({ p }) => ({ ...cardOf(p), availableInNames: p.availableIn.map(nameOf), includesNames: p.includes.map(nameOf) })) });
}

/** Short catalog + store summary for the phone agent. */
export async function phoneBriefing() {
  if (knowledgeOnly()) {
    const brand = brandName();
    return `You are ${settings().assistantName}, calling on behalf of ${brand}. Your ONLY source of facts about ${brand} is the ask_farq_knowledge tool: call it for any factual question (say something natural like "one sec, let me check" first) and answer only from what it returns. Never guess or invent details; if it has no answer or is unavailable, say you'll have someone follow up by email.`;
  }
  const s = settings();
  const cat = await catalogDigest();
  return `\n\n## Store facts\n${s.about}\n${s.policies}\nContact: ${s.contact}\n\n## Catalog\n${cat.text}\n\nOn the phone you cannot place orders: if they want to buy, tell them the item name and that they can buy it in the chat on the website in a few taps.`;
}
