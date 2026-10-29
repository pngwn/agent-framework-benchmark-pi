#!/usr/bin/env node
// Writes the models.json entry for the model a run uses and prints the pi model reference.
//
// With a provider, it pins a Hugging Face Inference Provider by adding "<model>:<provider>"
// (the HF router's suffix syntax), copied from the built-in catalog entry so context window,
// max tokens, thinking levels and prices stay the same. Without a pin the router picks a
// provider per request, and providers differ in quantisation, speed and tool-call parsing,
// which adds noise to an eval. Without one, it overrides the built-in entry instead.
//
// Either way it caps image size. HF providers reject request bodies of a few MB (together
// returns 413 at ~4-5 MB), and the agents read the 18 reference screenshots, so pi's default
// (images up to 2000 px, 4.5 MiB each) forces overflow compactions after a handful of reads.
// The cap matches what the Anthropic API does to Claude Code's images (long edge 1568 px).
//
// Usage: pin-provider.mjs <models.json out> <model id> [hf provider]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const IMAGE_LIMITS = { images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 400_000, jpegQuality: 80 } } };

const [out, modelId, hfProvider] = process.argv.slice(2);
const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
// pi-ai is nested under pi-coding-agent, or hoisted next to it.
const aiDir = [
  path.join(globalRoot, '@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai'),
  path.join(globalRoot, '@earendil-works/pi-ai'),
].find((d) => fs.existsSync(d));
if (!aiDir) throw new Error('@earendil-works/pi-ai not found');
const catalog = JSON.parse(fs.readFileSync(path.join(aiDir, 'dist/providers/data/huggingface.json'), 'utf8'));

const entry = Object.values(catalog).flatMap((byId) => Object.values(byId)).find((m) => m.id === modelId);
if (!entry) throw new Error(`${modelId} is not in pi's Hugging Face catalog`);
const inputLimits = { ...entry.inputLimits, ...IMAGE_LIMITS };

let models, ref;
if (hfProvider) {
  const { id, name, api, provider, baseUrl, type, compat, ...rest } = entry;
  models = {
    providers: {
      'hf-pinned': {
        baseUrl,
        api,
        apiKey: '$HF_TOKEN',
        compat,
        models: [{ ...rest, inputLimits, id: `${modelId}:${hfProvider}`, name: `${name} (${hfProvider})` }],
      },
    },
  };
  ref = `hf-pinned/${modelId}:${hfProvider}`;
} else {
  models = { providers: { huggingface: { modelOverrides: { [modelId]: { inputLimits } } } } };
  ref = `huggingface/${modelId}`;
}
fs.writeFileSync(out, JSON.stringify(models, null, 2));
console.log(ref);
