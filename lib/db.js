// Tiny JSON-file storage (no database needed). Writes are atomic (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// DATA_DIR can point at a persistent volume (e.g. /data on Railway). Default: ./data
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// First boot on an empty data dir: copy the starter files from ./seed (never overwrites existing data).
try {
  const seedDir = path.join(ROOT, 'seed');
  for (const f of fs.readdirSync(seedDir)) {
    const dest = path.join(DATA_DIR, f);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(seedDir, f), dest);
  }
} catch { /* no seed folder – fine */ }

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
