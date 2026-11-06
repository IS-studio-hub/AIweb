// AI provider – any OpenAI-compatible Chat Completions API.
// To switch to your own API later, set in .env:
//   AI_BASE_URL=https://your-api.example.com/v1
//   AI_API_KEY=...
//   AI_CHAT_MODEL=your-model
// Your API must accept POST {AI_BASE_URL}/chat/completions with the OpenAI request format
// (messages, tools, stream: true) and stream back OpenAI-style SSE chunks.
const env = (k) => (process.env[k] || '').trim();

export const aiConfig = () => ({
  base: (env('AI_BASE_URL') || env('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/$/, ''),
  key: env('AI_API_KEY') || env('OPENAI_API_KEY'),
  model: env('AI_CHAT_MODEL') || env('OPENAI_CHAT_MODEL') || 'gpt-4o-mini',
});

export class AIError extends Error {}

/**
 * Streams one model turn.
 * Yields { type: 'text', delta } … then finally { type: 'end', toolCalls: [{id,name,arguments}], text }.
 */
export async function* streamChat({ messages, tools, temperature = 0.7 }) {
  const { base, key, model } = aiConfig();
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: tools?.length ? tools : undefined, temperature, stream: true }),
  });
  if (!r.ok) {
    let msg = `AI error ${r.status}`;
    try { msg = (await r.json()).error?.message || msg; } catch {}
    console.error('[ai]', msg);
    throw new AIError(r.status === 401 ? 'The AI service rejected the API key.' : 'The AI service is unavailable right now.');
  }
  const dec = new TextDecoder();
  let buf = '', text = '';
  const calls = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const d = j.choices?.[0]?.delta || {};
      if (d.content) { text += d.content; yield { type: 'text', delta: d.content }; }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        calls[i] ||= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    }
  }
  yield { type: 'end', text, toolCalls: calls.filter((c) => c && c.name) };
}

/** Plain (non-streamed) completion, used for small helper tasks. */
export async function complete(messages) {
  let out = '';
  for await (const ev of streamChat({ messages })) if (ev.type === 'text') out += ev.delta;
  return out.trim();
}
