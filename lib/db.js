// Tiny JSON-file storage (no database needed). Writes are atomic (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export function jsonStore(name, fallback) {
  const file = path.join(DATA_DIR, name);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = structuredClone(typeof fallback === 'function' ? fallback() : fallback);
    write();
  }
  let timer = null;
  function write() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  return {
    get: () => data,
    set(next) { data = next; write(); return data; },
    update(fn) { const r = fn(data); write(); return r; },
    /** Debounced save for frequently-changing data (carts). */
    touch() { clearTimeout(timer); timer = setTimeout(write, 500); },
    file,
  };
}

export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
