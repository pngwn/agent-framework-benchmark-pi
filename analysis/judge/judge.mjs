#!/usr/bin/env node
// LLM judges. Each judge is a read-only Pi session (in the agent image, with the same
// framework skills and docs MCP the agent had, plus web search) that reviews one app against
// one rubric in analysis/judge/rubrics/ and ends with a JSON verdict. Each (app, rubric) is
// sampled several times; the report takes medians.
//
//   node analysis/judge/judge.mjs runs/<id> [options]     judge a run's iterations
//   node analysis/judge/judge.mjs --opus [options]        judge Nolan's Opus apps
// Options:
//   --dimensions=a,b    rubric names (default: all; "trace" needs a Pi trace, so not --opus)
//   --samples=N         verdicts per (app, dimension) (default 3)
//   --frameworks=a,b    limit to these frameworks
//   --opus-all          with --opus, every passing iteration instead of the median one
//   --per-framework=N   only the N passing iterations per framework nearest its median significant LOC
//   --model=ID          judge model (default zai-org/GLM-5.3)
//   --hf-provider=NAME  pin a provider (default together; "auto" = router picks)
//   --thinking=LEVEL    default high
//   --parallel=N        judges at once (default 2)
//   --force             re-run verdicts that already exist
//   --runtime=docker|podman
//
// Output: <iteration>/judge/<dimension>/<sample>/{verdict.json, session/, events.jsonl}.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORKS } from '../../upstream/bench/frameworks.mjs';
import { loadEnv } from '../../harness/env.mjs';
import { opusBase, opusIterations } from '../../baselines/opus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RUBRICS = path.join(HERE, 'rubrics');
const IMAGE = 'pokedex-pi-agent';

const opts = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    return [m[1], m[2] ?? true];
  }),
);
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const config = {
  samples: Number(opts.samples ?? 3),
  model: opts.model ?? 'zai-org/GLM-5.3',
  hfProvider: opts['hf-provider'] === 'auto' ? '' : (opts['hf-provider'] ?? 'together'),
  thinking: opts.thinking ?? 'high',
  parallel: Number(opts.parallel ?? 2),
  runtime: opts.runtime ?? 'docker',
};

// ---------- rubrics ----------

function loadRubric(name) {
  const text = fs.readFileSync(path.join(RUBRICS, `${name}.md`), 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  const meta = { target: 'app', extra: '' };
  if (fm) {
    const extra = fm[1].match(/^extra: \|\n((?:  .*\n?)*)/m);
    if (extra) meta.extra = extra[1].replace(/^  /gm, '').trim();
    const target = fm[1].match(/^target: (\w+)/m);
    if (target) meta.target = target[1];
  }
  return { name, ...meta, body: fm ? text.slice(fm[0].length) : text };
}
const allDimensions = () => fs.readdirSync(RUBRICS).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.replace(/\.md$/, ''));

function buildPrompt(rubric, { framework, facts }) {
  const common = fs.readFileSync(path.join(RUBRICS, '_common.md'), 'utf8');
  const extra = rubric.extra ? `,\n  ${rubric.extra.replace(/\n/g, '\n  ')}` : '';
  return (
    common
      .replaceAll('{{framework}}', FRAMEWORKS[framework] ?? framework)
      .replaceAll('{{date}}', new Date().toISOString().slice(0, 10))
      .replaceAll('{{dimension}}', rubric.name)
      .replaceAll('{{facts}}', JSON.stringify(facts, null, 2))
      .replaceAll('{{extraFields}}', extra) +
    '\n\n' +
    rubric.body
  );
}

// ---------- targets ----------

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

// Facts given to the judge: static-analysis summary (no per-file list) or trace metrics.
function factsFor(target, rubric) {
  if (rubric.target === 'trace') {
    const t = readJson(path.join(target.dir, 'analysis/trace.json'));
    if (!t) return null;
    const { loop, ...rest } = t;
    return { ...rest, loop: { ...loop, testRuns: loop.testRuns.map(({ failures, ...r }) => ({ ...r, failures: failures.slice(0, 5) })) } };
  }
  const code = readJson(path.join(target.dir, 'analysis/code.json'));
  if (!code) return null;
  const { files, ...summary } = code;
  return summary;
}

function runTargets(runDir) {
  return fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-\d+$/.test(d.name))
    .map((d) => {
      const dir = path.join(runDir, d.name);
      return { name: d.name, dir, framework: d.name.replace(/-\d+$/, ''), app: path.join(dir, 'repo/app') };
    })
    .filter((t) => fs.existsSync(t.app));
}

function opusTargets() {
  const out = path.join(ROOT, 'baselines/opus-analysis');
  return Object.keys(FRAMEWORKS).flatMap((fw) => {
    const its = opts['opus-all'] || opts['per-framework'] ? opusIterations(fw) : [opusBase(fw)];
    return its.map((it) => ({ name: it.name, dir: path.join(out, it.name), framework: fw, app: it.app }));
  });
}

// --per-framework=N: the N passing iterations whose significant LOC is closest to their
// framework's median, so judges see typical apps rather than outliers.
function typical(targets, n) {
  const sig = (t) => readJson(path.join(t.dir, 'analysis/code.json'))?.totals.significantLoc ?? null;
  const passed = (t) => /^final_test_exit=0$/m.test(fs.existsSync(path.join(t.dir, 'agent/run-info.txt')) ? fs.readFileSync(path.join(t.dir, 'agent/run-info.txt'), 'utf8') : '');
  const byFw = {};
  for (const t of targets) if (passed(t) && sig(t) !== null) (byFw[t.framework] ??= []).push({ t, loc: sig(t) });
  return Object.values(byFw).flatMap((list) => {
    const sorted = list.map((x) => x.loc).sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    return list.sort((a, b) => Math.abs(a.loc - median) - Math.abs(b.loc - median) || a.t.name.localeCompare(b.t.name)).slice(0, n).map((x) => x.t);
  });
}

// ---------- running ----------

function runJudge(target, rubric, sample) {
  const out = path.join(target.dir, 'judge', rubric.name, String(sample));
  if (!opts.force && fs.existsSync(path.join(out, 'verdict.json'))) return Promise.resolve('cached');
  const facts = factsFor(target, rubric);
  if (!facts) return Promise.resolve(`skipped: no analysis for ${rubric.target} (run analysis/analyze.mjs first)`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const judgeDir = path.join(out, '.judge');
  fs.mkdirSync(judgeDir);
  fs.writeFileSync(path.join(judgeDir, 'prompt.md'), buildPrompt(rubric, { framework: target.framework, facts }));
  for (const [src, dst] of [['seed/FEATURE.md', 'FEATURE.md'], ['analysis/changes.diff', 'CHANGES.diff'], ['analysis/trace.md', 'trace.md']]) {
    if (dst === 'trace.md' && rubric.target !== 'trace') continue;
    const f = path.join(target.dir, src);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(judgeDir, dst));
  }
  if (os.platform() !== 'darwin') for (const d of [out, judgeDir]) fs.chmodSync(d, 0o777);

  const env = { ...process.env, FRAMEWORK: target.framework, JUDGE_MODEL: config.model, HF_PROVIDER: config.hfProvider, THINKING: config.thinking, RUN_ID: `judge-${target.name}-${rubric.name}-${sample}` };
  const pass = ['FRAMEWORK', 'JUDGE_MODEL', 'HF_PROVIDER', 'THINKING', 'RUN_ID', 'HF_TOKEN', 'EXA_API_KEY'].flatMap((k) => ['-e', k]);
  const z = config.runtime === 'podman' ? ',Z' : '';
  const args = [
    'run', '--rm', '--cpus=2', '--memory=4g', '--add-host=pokeapi.co:127.0.0.1',
    '-v', `${target.app}:/target:ro${z}`, '-v', `${judgeDir}:/judge:ro${z}`, '-v', `${out}:/out${z ? ':Z' : ''}`,
    ...pass, '--entrypoint', '/home/agent/run-judge.sh', IMAGE,
  ];
  return new Promise((resolve) => {
    const logFd = fs.openSync(path.join(out, 'container.log'), 'a');
    const child = spawn(config.runtime, args, { stdio: ['ignore', logFd, logFd], env });
    child.on('exit', (code) => {
      fs.closeSync(logFd);
      resolve(fs.existsSync(path.join(out, 'verdict.json')) ? 'ok' : `failed (exit ${code}; see ${path.relative(ROOT, out)})`);
    });
  });
}

async function main() {
  loadEnv(path.join(ROOT, '.env.local'));
  loadEnv(path.join(ROOT, '.env'));

  let targets = opts.opus ? opusTargets() : runTargets(path.resolve(positional[0] ?? ''));
  if (opts['per-framework']) targets = typical(targets, Number(opts['per-framework']));
  if (opts.list) {
    for (const t of targets) console.log(`${t.name.padEnd(18)} ${readJson(path.join(t.dir, 'analysis/code.json'))?.totals.significantLoc ?? '?'} significant LOC`);
    return;
  }
  if (opts.frameworks) {
    const fws = String(opts.frameworks).split(',');
    targets = targets.filter((t) => fws.includes(t.framework));
  }
  for (const k of ['HF_TOKEN', 'EXA_API_KEY']) if (!process.env[k]) throw new Error(`${k} is not set (environment, .env.local or .env)`);
  if (spawnSync(config.runtime, ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) throw new Error(`Image ${IMAGE} not found: run harness/run.mjs once to build it`);

  let dims = opts.dimensions ? String(opts.dimensions).split(',') : allDimensions();
  if (opts.opus) dims = dims.filter((d) => d !== 'trace'); // Opus transcripts weren't published
  const rubrics = dims.map(loadRubric);

  const jobs = targets.flatMap((t) => rubrics.flatMap((r) => Array.from({ length: config.samples }, (_, i) => ({ t, r, i: i + 1 }))));
  console.log(`${jobs.length} judge runs: ${targets.length} apps x ${rubrics.length} dimensions x ${config.samples} samples, model ${config.model}`);
  let done = 0;
  const workers = Array.from({ length: Math.max(1, config.parallel) }, async () => {
    while (jobs.length) {
      const { t, r, i } = jobs.shift();
      const status = await runJudge(t, r, i);
      console.log(`[${++done}] ${t.name} ${r.name} #${i}: ${status}`);
    }
  });
  await Promise.all(workers);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
