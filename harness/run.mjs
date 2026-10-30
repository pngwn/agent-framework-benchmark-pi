#!/usr/bin/env node
// Runs the Pokédex framework benchmark with Pi agents, end to end. A port of
// upstream/bench/run.mjs: same images, spec, tests, prompt and Lighthouse measurement, with
// Claude Code swapped for Pi + a Hugging Face model, and Docker as the default runtime.
//
//   1. Builds pokedex-base and pokedex-measure from upstream's Containerfiles, and
//      pokedex-pi-agent from harness/container/.
//   2. For every task x framework x iteration, runs one agent in its own container. When it
//      stops, the task's tests run against its app/ in a fresh pokedex-base container.
//   3. Measures each passing app in a pokedex-measure container (Lighthouse + upstream LOC),
//      one at a time so measurements don't compete for CPU.
//   4. Runs the analysis (traces, code stats) and writes runs/<id>/report.md.
//
// Usage:
//   node harness/run.mjs --frameworks=vanilla,astro [--iterations=1] [options]
//   node harness/run.mjs --task=extend-compare --frameworks=all
//   node harness/run.mjs --frameworks=all --append-to=runs/<id>   add iterations to a run
//   node harness/run.mjs --frameworks=all --iterations=5 --resume=runs/<id>   finish an interrupted run
//   node harness/run.mjs --measure-only=runs/<id>
// Options:
//   --task=NAME             build (default: the original spec) or a directory in tasks/
//   --frameworks=a,b|all    keys in upstream/bench/frameworks.mjs
//   --iterations=N          agent runs per framework (default 1)
//   --parallel=N            agents running at once (default 1; measurement is always serial)
//   --model=ID              pi huggingface model id (default deepseek-ai/DeepSeek-V4.1-Flash-1017)
//   --hf-provider=NAME      pin an HF Inference Provider (default together; "auto" = router picks)
//   --thinking=LEVEL        pi --thinking (default high, like upstream's --effort=high)
//   --max-turns=N           turn cap enforced by the run-guard extension (default 500)
//   --pi-version=V          pi npm version for the agent image (default 1.4.0)
//   --runtime=docker|podman (default docker)
//   --cpus=N --memory=SIZE  per-container limits (default 4 and 8g)
//   --agent-timeout=MIN     stop an agent after this many minutes (default 240)
//   --lighthouse-runs=N     Lighthouse runs per URL (default 5)
//   --no-cache --skip-image-build --no-measure --measure-failed --out=DIR
//   --build-only            build the images and stop
//
// Credentials: HF_TOKEN and EXA_API_KEY, from the environment, ./.env.local or ./.env. They're passed to
// agent containers as environment variables and never written to the run directory.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORKS } from '../upstream/bench/frameworks.mjs';
import { loadTask } from './tasks.mjs';
import { loadEnv } from './env.mjs';

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HARNESS, '..');
const UPSTREAM = path.join(ROOT, 'upstream');
const IMAGES = { base: 'pokedex-base', agent: 'pokedex-pi-agent', measure: 'pokedex-measure' };
const NODE_VERSION = fs.readFileSync(path.join(UPSTREAM, 'template/.nvmrc'), 'utf8').trim();

// ---------- Options ----------

const opts = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw new Error(`Unexpected argument: ${arg}`);
    return [m[1], m[2] ?? true];
  }),
);
const num = (key, fallback) => {
  if (opts[key] === undefined) return fallback;
  const n = Number(opts[key]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} must be a non-negative number`);
  return n;
};
const config = {
  task: opts.task ?? 'build',
  iterations: num('iterations', 1),
  parallel: num('parallel', 1),
  cpus: num('cpus', 4),
  memory: opts.memory ?? '8g',
  agentTimeoutMin: num('agent-timeout', 240),
  lighthouseRuns: num('lighthouse-runs', 5),
  model: opts.model ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  hfProvider: opts['hf-provider'] === 'auto' ? '' : (opts['hf-provider'] ?? 'together'),
  thinking: opts.thinking ?? 'high',
  maxTurns: num('max-turns', 500),
  piVersion: opts['pi-version'] ?? '1.4.0',
  runtime: opts.runtime ?? 'docker',
};
const RT = config.runtime;

// ---------- Helpers ----------

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

function runLogged(cmd, args, logFile, { env, timeoutMs, onTimeout } = {}) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { stdio: ['ignore', out, out], env });
    const timer = timeoutMs ? setTimeout(() => onTimeout?.(), timeoutMs) : null;
    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve(code ?? 1);
    });
  });
}

// Containers run as "agent" (uid 1000). Rootless Podman maps that to you; Docker Desktop
// (macOS) shares files through its VM so ownership doesn't matter; rootful Podman and
// Docker on Linux can't map it, so directories they write to are opened up instead.
const mapsUser = RT === 'podman' && process.getuid?.() !== 0;
const sharesViaVm = RT === 'docker' && os.platform() === 'darwin';
const userns = mapsUser ? ['--userns=keep-id:uid=1000,gid=1000'] : [];
const writableDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  if (!mapsUser && !sharesViaVm) fs.chmodSync(dir, 0o777);
};
const containerArgs = [...userns, `--cpus=${config.cpus}`, `--memory=${config.memory}`];
const blockPokeapi = ['--add-host=pokeapi.co:127.0.0.1', '--add-host=www.pokeapi.co:127.0.0.1'];
// The measure stack serves the app and API at app.localhost / api.localhost behind Caddy. On
// upstream's Ubuntu hosts systemd-resolved maps *.localhost to loopback; Docker's DNS doesn't,
// so Node in the app server can't reach the API (Chrome resolves *.localhost itself).
const localhostNames = ['--add-host=app.localhost:127.0.0.1', '--add-host=api.localhost:127.0.0.1'];
// SELinux relabelling is a Podman-on-Linux concern; Docker Desktop rejects nothing but ignores it.
const vol = (src, dst, mode = '') => ['-v', `${src}:${dst}${mode ? `:${mode}` : ''}${RT === 'podman' ? (mode ? ',Z' : ':Z') : ''}`];

function preflight() {
  const v = spawnSync(RT, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error(`${RT} not found on PATH`);
  const info = spawnSync(RT, ['info'], { encoding: 'utf8' });
  if (info.status !== 0) throw new Error(`${RT} isn't running (${RT} info failed). Start Docker Desktop or the Podman machine.`);
  return v.stdout.trim();
}

function credentials() {
  const missing = ['HF_TOKEN', 'EXA_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}: set them in the environment, .env.local or .env`);
}

// ---------- Step 1: images ----------

function buildImages(runDir) {
  const ctx = path.join(runDir, '.build');
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  sh(path.join(UPSTREAM, 'bench/container/export-template.sh'), [path.join(ctx, 'work')]);
  const cacheArgs = opts['no-cache'] ? ['--no-cache', '--pull'] : [];
  const build = (image, file, context, extra = []) => {
    log(`Building ${image}`);
    sh(RT, ['build', ...cacheArgs, '-t', image, '-f', file, ...extra, context]);
  };
  build(IMAGES.base, path.join(UPSTREAM, 'bench/container/Containerfile.base'), ctx, ['--build-arg', `NODE_VERSION=${NODE_VERSION}`]);
  build(IMAGES.agent, path.join(HARNESS, 'container/Containerfile.agent'), path.join(HARNESS, 'container'), [
    '--build-arg', `BASE=${IMAGES.base}`,
    '--build-arg', `PI_VERSION=${config.piVersion}`,
    '--build-context', `upstream=${path.join(UPSTREAM, 'bench/container')}`,
  ]);
  build(IMAGES.measure, path.join(UPSTREAM, 'bench/container/Containerfile.measure'), path.join(UPSTREAM, 'bench'), ['--build-arg', `BASE=${IMAGES.base}`]);
  fs.rmSync(ctx, { recursive: true, force: true });
  const inspect = (image) => spawnSync(RT, ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).stdout.trim() || null;
  updateConfig(runDir, { images: Object.fromEntries(Object.values(IMAGES).map((i) => [i, inspect(i)])) });
}

function updateConfig(runDir, patch) {
  const file = path.join(runDir, 'config.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
}

// ---------- Step 2: agents ----------

async function runAgent(runId, iterDir, framework, task) {
  const out = path.join(iterDir, 'agent');
  writableDir(out);
  const name = `pokedex-${runId}-${path.basename(iterDir)}`;
  const seed = task.seed?.(framework, iterDir);
  const env = {
    ...process.env,
    FRAMEWORK: framework,
    PROMPT: task.prompt(FRAMEWORKS[framework]),
    MODEL: config.model,
    HF_PROVIDER: config.hfProvider,
    THINKING: config.thinking,
    PI_MAX_TURNS: String(config.maxTurns),
    RUN_ID: `${runId}-${path.basename(iterDir)}`,
  };
  const passEnv = ['FRAMEWORK', 'PROMPT', 'MODEL', 'HF_PROVIDER', 'THINKING', 'PI_MAX_TURNS', 'RUN_ID', 'HF_TOKEN', 'EXA_API_KEY'].flatMap((k) => ['-e', k]);
  // No writable host mount while the agent runs: it writes its outputs inside the container
  // and they're copied out afterwards. (An early run that hit a full disk found the old /out
  // mount with `df` and moved the 1.5 GB dataset onto the host through it.)
  spawnSync(RT, ['rm', '-f', name], { stdio: 'ignore' });
  const args = [
    'run', '--name', name, ...containerArgs, ...blockPokeapi,
    ...(seed ? vol(seed, '/seed', 'ro') : []),
    ...passEnv,
    IMAGES.agent,
  ];
  log(`Agent start: ${path.basename(iterDir)}`);
  const code = await runLogged(RT, args, path.join(iterDir, 'container.log'), {
    env,
    timeoutMs: config.agentTimeoutMin * 60_000,
    onTimeout: () => {
      log(`Agent timeout: ${path.basename(iterDir)} after ${config.agentTimeoutMin} min`);
      fs.writeFileSync(path.join(iterDir, 'TIMED_OUT'), `${config.agentTimeoutMin} minutes\n`);
      spawnSync(RT, ['stop', '-t', '30', name]); // run-agent.sh saves the repo on SIGTERM
    },
  });
  const copied = spawnSync(RT, ['cp', `${name}:/home/agent/out/.`, out], { encoding: 'utf8' });
  if (copied.status !== 0) fs.appendFileSync(path.join(iterDir, 'container.log'), `\ncopying outputs failed: ${copied.stderr}`);
  spawnSync(RT, ['rm', '-f', name], { stdio: 'ignore' });
  log(`Agent done:  ${path.basename(iterDir)} (container exit ${code})`);
}

function extractRepo(iterDir) {
  const repo = path.join(iterDir, 'repo');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo);
  sh('tar', ['-xzf', path.join(iterDir, 'agent/repo.tar.gz'), '-C', repo]);
  if (!mapsUser && !sharesViaVm) sh('chmod', ['-R', 'a+rwX', repo]);
  return repo;
}

// The task's tests (upstream's, plus the feature's for extension tasks) against the agent's
// app/ only, in a fresh container.
async function testApp(iterDir, task) {
  if (!fs.existsSync(path.join(iterDir, 'agent/repo.tar.gz'))) return;
  const app = path.join(extractRepo(iterDir), 'app');
  fs.mkdirSync(app, { recursive: true });
  const featureSpecs = task.testSpecsDir;
  const cmd = featureSpecs ? 'cp -r /src app && cp /feature-specs/*.mjs tests/specs/ && npm test' : 'cp -r /src app && npm test';
  log(`Tests start: ${path.basename(iterDir)}`);
  const code = await runLogged(
    RT,
    ['run', '--rm', ...containerArgs, ...blockPokeapi, ...vol(app, '/src', 'ro'), ...(featureSpecs ? vol(featureSpecs, '/feature-specs', 'ro') : []), IMAGES.base, 'bash', '-c', cmd],
    path.join(iterDir, 'agent/final-test.log'),
  );
  fs.appendFileSync(path.join(iterDir, 'agent/run-info.txt'), `final_test_exit=${code}\n`);
  log(`Tests done:  ${path.basename(iterDir)} (${code === 0 ? 'pass' : `fail, exit ${code}`})`);
}

// An iteration is complete once the agent's repo was saved. Incomplete ones (interrupted
// runs) are cleared and run again. A fresh run or --append-to adds config.iterations per
// framework; --resume tops each framework up to config.iterations complete ones.
const isComplete = (dir) => fs.existsSync(path.join(dir, 'agent/repo.tar.gz'));

async function runAgents(runId, runDir, frameworks, task) {
  const jobs = [];
  for (const fw of frameworks) {
    const existing = (i) => path.join(runDir, `${fw}-${i}`);
    let complete = 0;
    for (let i = 1; fs.existsSync(existing(i)); i++) if (isComplete(existing(i))) complete++;
    const wanted = opts.resume ? Math.max(0, config.iterations - complete) : config.iterations;
    for (let i = 1, added = 0; added < wanted; i++) {
      const dir = existing(i);
      if (isComplete(dir)) continue;
      added++;
      jobs.push(async () => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        await runAgent(runId, dir, fw, task);
        await testApp(dir, task);
      });
    }
  }
  log(`${jobs.length} agent run(s) queued, ${Math.max(1, config.parallel)} at a time`);
  const workers = Array.from({ length: Math.max(1, config.parallel) }, async () => {
    while (jobs.length) await jobs.shift()();
  });
  await Promise.all(workers);
}

// ---------- Step 3: measurement (upstream's measure.mjs, unchanged) ----------

async function measure(iterDir) {
  const tarball = path.join(iterDir, 'agent/repo.tar.gz');
  const results = path.join(iterDir, 'measure');
  fs.rmSync(results, { recursive: true, force: true });
  writableDir(results);
  const fail = (msg) => {
    fs.writeFileSync(path.join(results, 'error.txt'), `${msg}\n`);
    log(`Measure failed: ${path.basename(iterDir)}: ${msg}`);
  };
  if (!fs.existsSync(tarball)) return fail('no repo.tar.gz (the agent run did not finish)');
  const info = fs.readFileSync(path.join(iterDir, 'agent/run-info.txt'), 'utf8');
  const testExit = info.match(/^final_test_exit=(.*)$/m)?.[1];
  if (testExit !== '0' && !opts['measure-failed']) return fail(`skipped: final tests failed (exit ${testExit ?? '?'}); use --measure-failed to measure anyway`);
  const repo = extractRepo(iterDir);
  if (!fs.existsSync(path.join(repo, 'app/package.json'))) return fail('no app/package.json');
  log(`Measure start: ${path.basename(iterDir)}`);
  const code = await runLogged(
    RT,
    // --measure-env=HOST=0.0.0.0: an app that binds only to localhost can pick ::1 under Docker
    // (whose /etc/hosts lists it), while Node's fetch in stack.mjs tries 127.0.0.1.
    ['run', '--rm', ...containerArgs, ...localhostNames, ...String(opts['measure-env'] ?? '').split(',').filter(Boolean).flatMap((e) => ['-e', e]), ...vol(repo, '/repo'), ...vol(results, '/results'), IMAGES.measure, '/repo/app', '/results', '--runs', String(config.lighthouseRuns)],
    path.join(results, 'measure.log'),
  );
  if (code !== 0) return fail(`measure container exited with ${code}; see measure/measure.log`);
  extractRepo(iterDir); // measuring installs and builds in place; leave a clean copy for analysis
  log(`Measure done:  ${path.basename(iterDir)}`);
}

const iterationDirs = (runDir) =>
  fs.readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-\d+$/.test(d.name))
    .map((d) => path.join(runDir, d.name))
    .sort();

// ---------- Step 4: analysis ----------

function analyze(runDir) {
  sh(process.execPath, [path.join(ROOT, 'analysis/analyze.mjs'), runDir]);
}

// ---------- Main ----------

async function main() {
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0].replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
    return;
  }
  loadEnv(path.join(ROOT, '.env.local'));
  loadEnv(path.join(ROOT, '.env'));
  const runtimeVersion = preflight();

  if (opts['build-only']) {
    const dir = path.join(ROOT, 'runs/.images');
    fs.mkdirSync(dir, { recursive: true });
    buildImages(dir);
    return;
  }

  if (opts['measure-only']) {
    const runDir = path.resolve(opts['measure-only']);
    for (const dir of iterationDirs(runDir)) await measure(dir);
    analyze(runDir);
    return;
  }

  if (!opts.frameworks) throw new Error(`--frameworks is required. Choose from: ${Object.keys(FRAMEWORKS).join(', ')}, or all`);
  const task = loadTask(config.task, ROOT);
  const frameworks = opts.frameworks === 'all' ? task.frameworks(Object.keys(FRAMEWORKS)) : String(opts.frameworks).split(',').map((s) => s.trim());
  const unknown = frameworks.filter((f) => !FRAMEWORKS[f]);
  if (unknown.length) throw new Error(`Unknown framework(s): ${unknown.join(', ')}`);
  credentials();

  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const existingRun = opts['append-to'] ?? opts.resume;
  const runDir = existingRun ? path.resolve(existingRun) : path.resolve(opts.out ?? path.join(ROOT, 'runs'), `${runId}-${config.task}`);
  fs.mkdirSync(runDir, { recursive: true });
  const upstreamCommit = spawnSync('git', ['-C', UPSTREAM, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  updateConfig(runDir, {
    [existingRun ? `${opts.resume ? 'resumed' : 'appended'}-${runId}` : 'run']: {
      ...config,
      frameworks,
      prompts: Object.fromEntries(frameworks.map((f) => [f, task.prompt(FRAMEWORKS[f])])),
      startedAt: new Date().toISOString(),
      nodeVersion: NODE_VERSION,
      upstreamCommit,
      runtime: runtimeVersion,
      host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus()[0]?.model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30) },
    },
  });
  log(`Run ${runId}: task ${config.task}, ${frameworks.join(', ')} x ${config.iterations} -> ${runDir}`);

  if (!opts['skip-image-build']) buildImages(runDir);
  await runAgents(runId, runDir, frameworks, task);
  if (!opts['no-measure']) for (const dir of iterationDirs(runDir)) await measure(dir);
  analyze(runDir);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
