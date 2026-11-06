// FARQ knowledge API – your own model/knowledge base built from your data.
// OpenAI stays the "brain" (conversation, selling, tools, voice, calls); this API is
// consulted as a knowledge source for factual questions about FARQ.
//
// .env:
//   KNOWLEDGE_API_URL=https://model-api-production-2f90.up.railway.app
//   KNOWLEDGE_API_KEY=sk-...
//   KNOWLEDGE_TIMEOUT_MS=20000   (optional – after this the assistant answers without it)
const env = (k) => (process.env[k] || '').trim();
const BASE = () => env('KNOWLEDGE_API_URL').replace(/\/+$/, '').replace(/\/v1$/, '');
const KEY = () => env('KNOWLEDGE_API_KEY');
const TIMEOUT = () => Number(env('KNOWLEDGE_TIMEOUT_MS')) || 20000;

export const knowledgeEnabled = () => !!(BASE() && KEY());

const cache = new Map(); // normalized question → { at, value }
const CACHE_MS = 30 * 60_000;
const norm = (q) => String(q).toLowerCase().replace(/\s+/g, ' ').trim();

const stats = { calls: 0, ok: 0, timeouts: 0, errors: 0, skipped: 0, lastMs: null, lastError: null };
// Circuit breaker: after a failure, skip the API for a few minutes so shoppers never wait on it.
const PAUSE_MS = 3 * 60_000;
let pausedUntil = 0;
const fail = () => { pausedUntil = Date.now() + PAUSE_MS; };
export const knowledgeStats = () => ({ ...stats, enabled: knowledgeEnabled(), url: BASE(), timeoutMs: TIMEOUT(), pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null });

/**
 * Ask the knowledge API a question.
 * Resolves to { ok, answer, sources, ms } – never throws.
 */
export async function askKnowledge(question, { timeoutMs = TIMEOUT(), useCache = true, force = false, history = [] } = {}) {
  if (history.length) useCache = false; // follow-up questions depend on the conversation
  if (!knowledgeEnabled()) return { ok: false, error: 'Knowledge API is not configured.' };
  const q = String(question || '').slice(0, 1000).trim();
  if (!q) return { ok: false, error: 'Empty question.' };
  const key = norm(q);
  const hit = useCache && cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };

  if (!force && Date.now() < pausedUntil) { stats.skipped++; return { ok: false, error: 'Knowledge base temporarily unavailable.', skipped: true }; }
  stats.calls++;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE()}/v1/chat`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: q, temperature: 0.2, max_tokens: 400, ...(history.length ? { history: history.slice(-8).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })) } : {}) }),
    });
    const ms = Date.now() - t0;
    stats.lastMs = ms;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      stats.errors++;
      if (r.status >= 500 || r.status === 429) fail();
      stats.lastError = `HTTP ${r.status}${j.error ? ': ' + (j.error.message || j.error) : ''}`;
      console.error('[knowledge]', stats.lastError);
      return { ok: false, error: r.status === 503 ? 'Knowledge base is still loading.' : 'Knowledge base unavailable.', ms };
    }
    const value = {
      ok: true,
      answer: String(j.reply ?? j.choices?.[0]?.message?.content ?? '').trim(),
      sources: Array.isArray(j.sources) ? j.sources.slice(0, 5).map((s) => (typeof s === 'string' ? s : s.title || s.url || s.source || JSON.stringify(s).slice(0, 160))) : [],
      ms,
    };
    stats.ok++;
    stats.lastError = null;
    pausedUntil = 0;
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return value;
  } catch (e) {
    const ms = Date.now() - t0;
    stats.lastMs = ms;
    if (e.name === 'AbortError') {
      stats.timeouts++;
      fail();
      stats.lastError = `Timed out after ${Math.round(ms / 1000)}s`;
      console.warn('[knowledge] timed out after', ms, 'ms');
      return { ok: false, error: 'Knowledge base did not answer in time.', ms };
    }
    stats.errors++;
    fail();
    stats.lastError = e.message;
    console.error('[knowledge]', e.message);
    return { ok: false, error: 'Knowledge base unreachable.', ms };
  } finally {
    clearTimeout(timer);
  }
}

export const KNOWLEDGE_TOOL_DESCRIPTION =
  "Ask FARQ's own knowledge base (built from FARQ's website and brand data) a factual question about FARQ: products, ingredients and percentages, " +
  'how and when to use each product, routine order, skin concerns, the brand story and team, subscriptions, shipping, returns, FAQs. ' +
  'Write a clear, self-contained question. Use it before answering any FARQ fact that is not already in the catalog or store facts.';
