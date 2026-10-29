#!/usr/bin/env node
// Runs the deterministic analyses over a run directory and writes its report.
//   node analysis/analyze.mjs runs/<id>     every iteration in the run
//   node analysis/analyze.mjs --opus        Nolan's Opus apps -> baselines/opus-analysis/
//
// Per iteration, into <iteration>/analysis/:
//   trace.json, trace.md   trace metrics and the condensed trace (analysis/trace.mjs)
//   code.json              significant-code stats of repo/app (analysis/code-stats.mjs)
//   diff.json, changes.diff  extension tasks only: the agent's change against the base app
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSession, analyzeSession, condenseSession, parseTestOutput } from './trace.mjs';
import { codeStats } from './code-stats.mjs';
import { writeReport } from './report.mjs';
import { FRAMEWORKS } from '../upstream/bench/frameworks.mjs';
import { opusIterations } from '../baselines/opus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const git = (repo, args) => spawnSync('git', ['-c', 'safe.directory=*', '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 2 ** 20 });

function ensureRepo(dir) {
  const repo = path.join(dir, 'repo');
  const tarball = path.join(dir, 'agent/repo.tar.gz');
  // Re-extract unless a complete app is there (an rsync can leave an empty directory skeleton).
  if (!fs.existsSync(path.join(repo, 'app/package.json')) && fs.existsSync(tarball)) {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(repo);
    const r = spawnSync('tar', ['-xzf', tarball, '-C', repo]);
    if (r.status !== 0) console.error(`${dir}: extracting repo.tar.gz failed`);
  }
  return fs.existsSync(path.join(repo, 'app')) ? repo : null;
}

// The agent's change to app/ since the base commit, new files included.
function diffStats(dir, repo) {
  const base = fs.readFileSync(path.join(dir, 'agent/base-commit.txt'), 'utf8').trim();
  git(repo, ['add', '-A', '-N', 'app']);
  const numstat = git(repo, ['diff', '--numstat', base, '--', 'app']).stdout.trim().split('\n').filter(Boolean);
  const status = git(repo, ['diff', '--name-status', base, '--', 'app']).stdout.trim().split('\n').filter(Boolean);
  write(path.join(dir, 'analysis/changes.diff'), git(repo, ['diff', base, '--', 'app']).stdout);
  let added = 0, removed = 0;
  for (const l of numstat) {
    const [a, r] = l.split('\t');
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  const count = (s) => status.filter((l) => l.startsWith(s)).length;
  const isLockfile = (f) => /package-lock\.json|pnpm-lock|yarn\.lock/.test(f);
  return {
    base,
    filesChanged: status.filter((l) => !isLockfile(l)).length,
    filesAdded: count('A'),
    filesModified: count('M'),
    filesDeleted: count('D'),
    linesAdded: added,
    linesRemoved: removed,
    files: status.map((l) => l.replace('\t', ' ')),
  };
}

function conceptDelta(before, after) {
  const set = (c) => new Set(Object.entries(c.concepts).flatMap(([k, v]) => v.map((x) => `${k}: ${x}`)));
  const b = set(before), a = set(after);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}

export function analyzeIteration(dir) {
  const out = path.join(dir, 'analysis');
  const sessionDir = path.join(dir, 'agent/session');
  const session = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).find((f) => f.endsWith('.jsonl'));
  if (session) {
    const entries = readSession(path.join(sessionDir, session));
    write(path.join(out, 'trace.json'), analyzeSession(entries));
    write(path.join(out, 'trace.md'), condenseSession(entries));
  }
  const repo = ensureRepo(dir);
  if (!repo) return;
  const code = codeStats(path.join(repo, 'app'));
  write(path.join(out, 'code.json'), code);

  const testLog = path.join(dir, 'agent/final-test.log');
  if (fs.existsSync(testLog)) write(path.join(out, 'final-test.json'), parseTestOutput(fs.readFileSync(testLog, 'utf8')));

  const baseApp = path.join(dir, 'seed/app');
  if (fs.existsSync(baseApp) && fs.existsSync(path.join(dir, 'agent/base-commit.txt'))) {
    const before = codeStats(baseApp);
    const delta = Object.fromEntries(Object.entries(code.totals).map(([k, v]) => [k, v - (before.totals[k] ?? 0)]));
    write(path.join(out, 'diff.json'), { ...diffStats(dir, repo), totalsBefore: before.totals, delta, concepts: conceptDelta(before, code) });
  }
}

function analyzeOpus() {
  const outRoot = path.join(ROOT, 'baselines/opus-analysis');
  for (const fw of Object.keys(FRAMEWORKS)) {
    for (const it of opusIterations(fw)) {
      write(path.join(outRoot, it.name, 'analysis/code.json'), codeStats(it.app));
      fs.cpSync(path.join(it.dir, 'agent/run-info.txt'), path.join(outRoot, it.name, 'agent/run-info.txt'));
      const results = path.join(it.dir, 'measure/results.json');
      if (fs.existsSync(results)) fs.cpSync(results, path.join(outRoot, it.name, 'measure/results.json'));
      console.log(`analyzed ${it.name}`);
    }
  }
  writeReport(outRoot, { title: 'Opus 5.5 baseline (Nolan Lawson, 2026-10-26)' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--opus') analyzeOpus();
  else {
    const runDir = path.resolve(process.argv[2]);
    for (const d of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (d.isDirectory() && /-\d+$/.test(d.name)) analyzeIteration(path.join(runDir, d.name));
    }
    writeReport(runDir);
    console.log(`Report: ${path.join(runDir, 'report.md')}`);
  }
}
