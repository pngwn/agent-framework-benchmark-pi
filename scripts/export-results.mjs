#!/usr/bin/env node
// Exports a run for publishing, split by where it goes:
//   --results=DIR  small, readable files for the GitHub results repo: run info, final test
//                  logs, the agent's app source, analyses, Lighthouse summaries, judge
//                  verdicts, report.md / summary.json
//   --traces=DIR   heavy files for the Hugging Face dataset: Pi sessions, event streams,
//                  condensed traces, judge sessions, full Lighthouse reports, plus an
//                  iterations.jsonl index the dataset viewer can show
//
//   node scripts/export-results.mjs runs/<id> --name=<published name> --results=DIR --traces=DIR
//   node scripts/export-results.mjs --opus --results=DIR     Opus baseline analyses + verdicts
//
// Every text file is scrubbed on the way out (API key values from the environment/.env.local,
// token-shaped strings, local paths, your git email, and any extra strings listed in
// SCRUB_STRINGS, e.g. a server's address), and the output is scanned again afterwards: the
// export fails if anything sensitive is still there. Nothing personal is hard-coded here;
// put SCRUB_STRINGS=a,b in .env.local.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadEnv } from '../harness/env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
  return [m[1], m[2] ?? true];
}));
const runDir = process.argv.slice(2).find((a) => !a.startsWith('--'));
loadEnv(path.join(ROOT, '.env.local'));
loadEnv(path.join(ROOT, '.env'));

// ---------- scrubbing ----------

const SECRETS = ['HF_TOKEN', 'EXA_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].map((k) => process.env[k]).filter((v) => v && v.length >= 8);
const gitEmail = (() => { try { return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const EXTRA = [gitEmail, ...(process.env.SCRUB_STRINGS ?? '').split(',')].map((v) => v.trim()).filter((v) => v.length >= 4);
const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RULES = [
  ...SECRETS.map((v) => [new RegExp(escape(v), 'g'), '[REDACTED]']),
  ...EXTRA.map((v) => [new RegExp(escape(v), 'g'), '[scrubbed]']),
  [/\bhf_[A-Za-z0-9]{30,}\b/g, 'hf_[REDACTED]'],
  [/\b(sk|gho|ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, '$1_[REDACTED]'],
  [/("?x-api-key"?\s*[:=]\s*"?)[A-Za-z0-9-]{20,}/gi, '$1[REDACTED]'],
  [new RegExp(escape(ROOT), 'g'), '.'],
  [/\/root\/frame-evals-poke/g, '.'],
  // Only this machine's account: a generic /home/<name>/ rule would also hit data such as
  // PokeAPI's /media/sprites/pokemon/other/home/shiny/25.png.
  [new RegExp(`/(Users|home)/${os.userInfo().username}\\b`, 'g'), '/$1/[user]'],
  [/\/private\/tmp\/claude-[\w./-]+/g, '[tmp]'],
];
const scrub = (text) => RULES.reduce((t, [re, to]) => t.replace(re, to), text);
const LEAKS = [
  ...SECRETS.map((v) => ({ test: (t) => t.includes(v), name: 'API key value' })),
  { test: (t) => /\bhf_[A-Za-z0-9]{30,}\b/.test(t), name: 'HF token' },
  ...EXTRA.map((v) => ({ test: (t) => t.includes(v), name: 'scrubbed string (git email or SCRUB_STRINGS)' })),
  { test: (t) => t.includes(`/${os.userInfo().username}/`), name: 'local username in a path' },
];

const TEXT = /\.(json|jsonl|md|txt|log|mjs|cjs|js|jsx|ts|tsx|vue|svelte|astro|html|css|scss|diff|yaml|yml|toml|sh|svg)$|(^|\/)[^.]+$/i;
function copy(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (TEXT.test(src) && fs.statSync(src).size < 200 * 2 ** 20) fs.writeFileSync(dst, scrub(fs.readFileSync(src, 'utf8')));
  else fs.copyFileSync(src, dst);
  return true;
}
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.output|\.next|\.nuxt|\.svelte-kit|\.astro|\.angular|\.vinxi|\.tanstack|test-results|playwright-report|coverage|\.cache)(\/|$)/;
function copyTree(src, dst, filter = () => true) {
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (SKIP.test(s) || e.isSymbolicLink()) continue;
    if (e.isDirectory()) copyTree(s, d, filter);
    else if (filter(s)) copy(s, d);
  }
}
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const iterations = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /-\d+$/.test(d.name)).map((d) => d.name).sort();

// ---------- results (GitHub) ----------

function exportResults(src, dst) {
  for (const f of ['config.json', 'report.md', 'summary.json']) copy(path.join(src, f), path.join(dst, f));
  for (const it of iterations(src)) {
    const i = path.join(src, it), o = path.join(dst, it);
    for (const f of ['run-info.txt', 'tooling-versions.json', 'mcp.json', 'mcp-status.json', 'models.json', 'final-test.log', 'git-status.txt', 'base-commit.txt', 'TURN_LIMIT']) copy(path.join(i, 'agent', f), path.join(o, 'agent', f));
    for (const f of ['BASE.txt', 'TIMED_OUT']) copy(path.join(i, f), path.join(o, f));
    copyTree(path.join(i, 'repo/app'), path.join(o, 'app'));
    copyTree(path.join(i, 'analysis'), path.join(o, 'analysis'), (f) => !f.endsWith('trace.md'));
    for (const f of ['results.json', 'error.txt']) copy(path.join(i, 'measure', f), path.join(o, 'measure', f));
    for (const f of ['results.json', 'NOTE.txt']) copy(path.join(i, 'measure-same-machine', f), path.join(o, 'measure-same-machine', f));
    const judge = path.join(i, 'judge');
    if (fs.existsSync(judge)) copyTree(judge, path.join(o, 'judge'), (f) => /verdict\.(json|txt)$|verdict-error\.txt$/.test(f));
  }
}

// ---------- traces (Hugging Face) ----------

function exportTraces(src, dst, name) {
  const index = [];
  const summary = readJson(path.join(src, 'summary.json'));
  for (const it of iterations(src)) {
    const i = path.join(src, it), o = path.join(dst, 'data', name, it);
    const session = fs.existsSync(path.join(i, 'agent/session')) && fs.readdirSync(path.join(i, 'agent/session')).find((f) => f.endsWith('.jsonl'));
    if (session) copy(path.join(i, 'agent/session', session), path.join(o, 'session.jsonl'));
    copy(path.join(i, 'agent/events.jsonl'), path.join(o, 'events.jsonl'));
    copy(path.join(i, 'analysis/trace.md'), path.join(o, 'trace.md'));
    copyTree(path.join(i, 'measure/lighthouse'), path.join(o, 'lighthouse'));
    const judge = path.join(i, 'judge');
    if (fs.existsSync(judge)) {
      for (const dim of fs.readdirSync(judge)) for (const n of fs.readdirSync(path.join(judge, dim))) {
        const sd = path.join(judge, dim, n, 'session');
        const f = fs.existsSync(sd) && fs.readdirSync(sd).find((x) => x.endsWith('.jsonl'));
        if (f) copy(path.join(sd, f), path.join(o, 'judge', `${dim}-${n}.jsonl`));
      }
    }
    const row = summary?.iterations?.find((x) => x.name === it) ?? {};
    const info = Object.fromEntries((fs.existsSync(path.join(i, 'agent/run-info.txt')) ? fs.readFileSync(path.join(i, 'agent/run-info.txt'), 'utf8') : '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const { judge: scores, ...metrics } = row;
    index.push({
      run: name, iteration: it, framework: it.replace(/-\d+$/, ''), model: info.model ?? null, hf_provider: info.hf_provider ?? null, thinking: info.thinking ?? null, pi: info.pi ?? null,
      prompt: info.prompt ?? null, tests_passed: info.final_test_exit === '0', started: info.started ?? null, finished: info.finished ?? null,
      session_file: session ? `data/${name}/${it}/session.jsonl` : null, trace_file: fs.existsSync(path.join(o, 'trace.md')) ? `data/${name}/${it}/trace.md` : null,
      metrics: JSON.stringify(metrics), judge_scores: JSON.stringify(scores ?? {}),
    });
  }
  const indexFile = path.join(dst, 'iterations.jsonl');
  const existing = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((r) => r.run !== name) : [];
  fs.writeFileSync(indexFile, [...existing, ...index].map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---------- verification ----------

function scan(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(p);
      else if (fs.statSync(p).size < 200 * 2 ** 20) {
        const t = fs.readFileSync(p, 'latin1');
        for (const l of LEAKS) if (l.test(t)) found.push(`${path.relative(dir, p)}: ${l.name}`);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

if (!SECRETS.length) console.warn('Warning: no API keys in the environment or .env.local, so key values are not scrubbed by value (patterns still are).');
if (opts.opus) {
  const src = path.join(ROOT, 'baselines/opus-analysis');
  exportResults(src, path.join(path.resolve(opts.results), 'baselines/opus-5.5'));
} else {
  if (!runDir || !opts.name) throw new Error('Usage: export-results.mjs runs/<id> --name=<name> --results=DIR --traces=DIR');
  if (opts.results) exportResults(path.resolve(runDir), path.join(path.resolve(opts.results), 'runs', opts.name));
  if (opts.traces) exportTraces(path.resolve(runDir), path.resolve(opts.traces), opts.name);
}
const leaks = [...(opts.results ? scan(path.resolve(opts.results)) : []), ...(opts.traces ? scan(path.resolve(opts.traces)) : [])];
if (leaks.length) {
  console.error(`Sensitive data found after scrubbing:\n${leaks.join('\n')}`);
  process.exit(1);
}
console.log('Export done; scan clean.');
