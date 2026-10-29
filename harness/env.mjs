import fs from 'node:fs';

// Minimal .env reader: KEY=value lines, # comments, optional quotes. Values already in the
// environment win, so `HF_TOKEN=... node harness/run.mjs` overrides the file.
export function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
