// Tasks an agent can be given. "build" is upstream's benchmark unchanged: implement SPEC.md
// from an empty app/. Every directory in tasks/ with a task.json is an extension task: the
// agent starts from an existing app (one of Nolan's Opus-built apps, so every framework
// starts from comparable code it didn't write) and adds the feature in FEATURE.md.
//
// task.json: { prompt: "... {framework} ...", feature: "FEATURE.md", tests: "tests", base: "opus" }
import fs from 'node:fs';
import path from 'node:path';
import { prompt as buildPrompt } from '../upstream/bench/frameworks.mjs';
import { opusBase } from '../baselines/opus.mjs';

export function listTasks(root) {
  const dir = path.join(root, 'tasks');
  return ['build', ...fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'task.json')))];
}

export function loadTask(name, root) {
  if (name === 'build') return { name, prompt: buildPrompt, frameworks: (all) => all };

  const dir = path.join(root, 'tasks', name);
  if (!fs.existsSync(path.join(dir, 'task.json'))) throw new Error(`Unknown task ${name}. Tasks: ${listTasks(root).join(', ')}`);
  const def = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  if (def.base !== 'opus') throw new Error(`${name}: unsupported base ${def.base}`);
  const testSpecsDir = path.join(dir, def.tests);
  return {
    name,
    testSpecsDir,
    prompt: (label) => def.prompt.replaceAll('{framework}', label),
    frameworks: (all) => all.filter((fw) => { try { return !!opusBase(fw); } catch { return false; } }),
    // Builds <iterDir>/seed: the base app plus the feature spec and its tests, laid out as
    // they go in the agent's repo. Recorded in seed/BASE.txt.
    seed(framework, iterDir) {
      const base = opusBase(framework);
      const seed = path.join(iterDir, 'seed');
      fs.rmSync(seed, { recursive: true, force: true });
      fs.cpSync(base.app, path.join(seed, 'app'), { recursive: true, filter: (src) => !/[/\\](node_modules|dist|build|\.output|\.next|\.svelte-kit|\.nuxt|\.astro|\.angular)$/.test(src) });
      fs.cpSync(path.join(dir, def.feature), path.join(seed, 'FEATURE.md'));
      fs.cpSync(testSpecsDir, path.join(seed, 'tests/specs'), { recursive: true });
      fs.writeFileSync(path.join(iterDir, 'BASE.txt'), `opus ${base.name} (${base.loc} LOC)\n`);
      return seed;
    },
  };
}
