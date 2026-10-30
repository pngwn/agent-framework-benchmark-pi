#!/usr/bin/env node
// Re-runs each iteration's final acceptance tests a few more times, in fresh containers with
// only the agent's app/ (exactly like the final test in run.mjs), to separate flaky results
// from real ones. Writes <iteration>/analysis/retest.json: { runs, passes, failures: {test: n} }.
//
// Usage: node harness/retest.mjs runs/<id> [--times=2] [--parallel=8] [--runtime=docker]
// Run it when nothing else is measuring: the tests are timing-sensitive, like the apps.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTestOutput } from '../analysis/trace.mjs';
import { loadTask } from './tasks.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
  return [m[1], m[2] ?? true];
}));
const runDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
const TIMES = Number(opts.times ?? 2);
const RT = opts.runtime ?? 'docker';
const config = JSON.parse(fs.readFileSync(path.join(runDir, 'config.json'), 'utf8'));
const task = loadTask(config.run?.task ?? 'build', ROOT);

function testOnce(app) {
  const cmd = task.testSpecsDir ? 'cp -r /src app && cp /feature-specs/*.mjs tests/specs/ && npm test' : 'cp -r /src app && npm test';
  const args = ['run', '--rm', '--cpus=4', '--memory=8g', '--add-host=pokeapi.co:127.0.0.1', '--add-host=www.pokeapi.co:127.0.0.1',
    '-v', `${app}:/src:ro`, ...(task.testSpecsDir ? ['-v', `${task.testSpecsDir}:/feature-specs:ro`] : []), 'pokedex-base', 'bash', '-c', cmd];
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(RT, args);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, ...parseTestOutput(out) }));
  });
}

const dirs = fs.readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /-\d+$/.test(d.name)).map((d) => path.join(runDir, d.name));
const jobs = dirs.filter((d) => fs.existsSync(path.join(d, 'repo/app/package.json')) || fs.existsSync(path.join(d, 'agent/repo.tar.gz')));
let done = 0;
async function retest(dir) {
  // A pristine copy of app/ from the tarball: measuring installs and builds in repo/ in place.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retest-'));
  await new Promise((r) => spawn('tar', ['-xzf', path.join(dir, 'agent/repo.tar.gz'), '-C', tmp, './app']).on('exit', r));
  if (os.platform() !== 'darwin') await new Promise((r) => spawn('chmod', ['-R', 'a+rwX', tmp]).on('exit', r));
  const results = [];
  for (let i = 0; i < TIMES; i++) results.push(await testOnce(path.join(tmp, 'app')));
  fs.rmSync(tmp, { recursive: true, force: true });
  const failures = {};
  for (const r of results) for (const f of r.failures) failures[f] = (failures[f] ?? 0) + 1;
  const summary = { runs: results.length, passes: results.filter((r) => r.code === 0).length, failures, at: new Date().toISOString() };
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'analysis/retest.json'), JSON.stringify(summary, null, 2));
  console.log(`[${++done}/${jobs.length}] ${path.basename(dir)}: ${summary.passes}/${summary.runs} passed${Object.keys(failures).length ? ` (${Object.keys(failures).join('; ')})` : ''}`);
}
const queue = [...jobs];
await Promise.all(Array.from({ length: Number(opts.parallel ?? 8) }, async () => {
  while (queue.length) await retest(queue.shift());
}));
