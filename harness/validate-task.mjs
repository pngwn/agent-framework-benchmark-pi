#!/usr/bin/env node
// Checks an extension task's tests in the pokedex-base image:
//   1. tasks/<task>/gold (reference implementation of the feature) passes every test,
//      upstream's and the feature's;
//   2. upstream/gold (no feature) fails the feature tests, so they really test the feature.
// Usage: node harness/validate-task.mjs <task> [--runtime=docker|podman]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const task = process.argv[2];
const RT = process.argv.find((a) => a.startsWith('--runtime='))?.split('=')[1] ?? 'docker';
if (!task) throw new Error('Usage: validate-task.mjs <task>');
const specs = path.join(ROOT, 'tasks', task, 'tests');

function npmTest(app, grep) {
  const cmd = `cp -r /src app && cp /feature-specs/*.mjs tests/specs/ && npm test${grep ? ` -- ${grep}` : ''} 2>&1 | tail -40`;
  const r = spawnSync(RT, ['run', '--rm', '--add-host=pokeapi.co:127.0.0.1', '-v', `${app}:/src:ro`, '-v', `${specs}:/feature-specs:ro`, 'pokedex-base', 'bash', '-o', 'pipefail', '-c', cmd], { encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}

const withFeature = npmTest(path.join(ROOT, 'tasks', task, 'gold'));
console.log(`gold with feature, all tests: ${withFeature.ok ? 'PASS' : 'FAIL'}\n${withFeature.out}`);
const featureOnly = npmTest(path.join(ROOT, 'upstream/gold'), `tests/specs/${task.replace(/^extend-/, '')}.spec.mjs`);
console.log(`upstream gold, feature tests: ${featureOnly.ok ? 'PASS (bad: tests do not need the feature)' : 'FAIL (good)'}\n${featureOnly.out.split('\n').filter((l) => /passed|failed/.test(l)).join('\n')}`);
process.exit(withFeature.ok && !featureOnly.ok ? 0 : 1);
