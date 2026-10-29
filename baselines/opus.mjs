// Nolan Lawson's published Opus 5.5 runs (github.com/nolanlawson/agent-framework-benchmark-results),
// used as (a) a baseline for the code analyses and judges, and (b) the starting apps for the
// extension tasks. Run `node baselines/opus.mjs fetch` once to clone them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OPUS_REPO = 'https://github.com/nolanlawson/agent-framework-benchmark-results.git';
export const OPUS_COMMIT = '4c2c18c3a993606feca4bd8d9894a73dc5b1936f';
export const OPUS_DIR = path.join(HERE, 'opus-results');
export const OPUS_RUN = path.join(OPUS_DIR, '20261026');

export function fetchOpus() {
  if (!fs.existsSync(OPUS_DIR)) {
    spawnSync('git', ['clone', '-q', OPUS_REPO, OPUS_DIR], { stdio: 'inherit' });
  }
  spawnSync('git', ['-C', OPUS_DIR, 'fetch', '-q', '--depth', '1', 'origin', OPUS_COMMIT], { stdio: 'inherit' });
  spawnSync('git', ['-C', OPUS_DIR, 'checkout', '-q', OPUS_COMMIT], { stdio: 'inherit' });
}

// Every Opus iteration that passed its final tests and was measured, with its LOC.
export function opusIterations(framework) {
  if (!fs.existsSync(OPUS_RUN)) throw new Error('Opus baselines missing: run `node baselines/opus.mjs fetch`');
  return fs
    .readdirSync(OPUS_RUN)
    .filter((d) => d.startsWith(`${framework}-`) && /-\d+$/.test(d) && d.slice(framework.length + 1).match(/^\d+$/))
    .map((d) => {
      const dir = path.join(OPUS_RUN, d);
      const info = fs.readFileSync(path.join(dir, 'agent/run-info.txt'), 'utf8');
      const results = path.join(dir, 'measure/results.json');
      const loc = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')).code?.sourceLines : null;
      return { name: d, dir, app: path.join(dir, 'agent/repo/app'), passed: /^final_test_exit=0$/m.test(info), loc };
    })
    .filter((it) => it.passed && it.loc && fs.existsSync(it.app));
}

// The base app for an extension task: the passing iteration with the median LOC, so the
// base is a typical app for that framework rather than the smallest or largest.
export function opusBase(framework) {
  const its = opusIterations(framework).sort((a, b) => a.loc - b.loc);
  if (!its.length) throw new Error(`No passing Opus iteration for ${framework}`);
  return its[Math.floor((its.length - 1) / 2)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'fetch') fetchOpus();
  for (const fw of ['next', 'nuxt', 'tanstack-start', 'react-router', 'solidstart', 'sveltekit', 'angular', 'astro', 'qwik', 'gracile', 'hono-htmx', 'vanilla']) {
    try {
      const b = opusBase(fw);
      console.log(`${fw.padEnd(16)} base ${b.name.padEnd(18)} ${b.loc} LOC`);
    } catch (err) {
      console.log(`${fw.padEnd(16)} ${err.message}`);
    }
  }
}
