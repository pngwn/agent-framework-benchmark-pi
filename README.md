# agent-framework-benchmark-pi

**Results:** [pngwn/agent-framework-benchmark-pi-results](https://github.com/pngwn/agent-framework-benchmark-pi-results)
· **Traces:** [pngwn/agent-framework-benchmark-pi-traces](https://huggingface.co/datasets/pngwn/agent-framework-benchmark-pi-traces) (Hugging Face)

A port of [nolanlawson/agent-framework-benchmark](https://github.com/nolanlawson/agent-framework-benchmark)
([blog post](https://nolanlawson.com/2026/10/28/the-ai-cost-of-javascript-frameworks/)) from
Claude Code + Opus to **[Pi](https://pi.dev) + open-weight models on Hugging Face Inference
Providers** (published runs: DeepSeek V4.1 Flash and Kimi K3), so every trace is inspectable,
plus analyses the original doesn't do:

| | What | Where |
| --- | --- | --- |
| Replication | Same spec, tests, prompt, per-framework MCP/skills, Lighthouse measurement | `harness/`, `upstream/` |
| Significant code | Lines a developer must reason about, tokens, functions, complexity, framework concepts | `analysis/code-stats.mjs` |
| LLM judges | Mergeability, forward-thinking, experimentalness, editability, test quality, process | `analysis/judge/` |
| Trace analysis | Failed calls, edit misses, fix cycles, stuck tests, loops, verification | `analysis/trace.mjs` |
| Extension tasks | Add the same feature to each framework's Opus-built app | `tasks/` |
| Opus baseline | Code + judge metrics for Nolan's 60 published Opus apps | `baselines/` |

## Setup

```sh
git clone --recursive https://github.com/pngwn/agent-framework-benchmark-pi.git
cd agent-framework-benchmark-pi
```

`upstream/` is a submodule: Nolan's benchmark at the commit this port was built against.

Requirements: Docker Desktop (or Podman), Node 22+, an HF token and an Exa key. Docker needs
~10 GB for the images plus ~2.5 GB per parallel agent (`--parallel=4`: give the VM 32 GB RAM
and ~25 GB free disk).

```sh
cp .env.example .env.local      # add HF_TOKEN and EXA_API_KEY (.env also works)
npm install                     # TypeScript, for the code analysis
node baselines/opus.mjs fetch   # Nolan's Opus runs (~240 MB), for baselines and extension tasks
node analysis/analyze.mjs --opus
node harness/run.mjs --build-only   # first build downloads ~2 GB of PokeAPI data, once
```

### On a VPS

`scripts/setup-vps.sh` sets up a fresh Ubuntu 24.04 box (Docker, Node, dependencies, baselines,
images); its header has the rsync and tmux commands. Use dedicated vCPUs if you care about
Lighthouse numbers: noisy neighbours on shared vCPUs move TBT and LCP. 16 vCPU / 64 GB / 100 GB
disk runs `--parallel=6` comfortably.

## Running

```sh
# Replicate the original: one framework, one iteration
node harness/run.mjs --frameworks=vanilla

# The whole grid, like the blog post
node harness/run.mjs --frameworks=all --iterations=5

# Extension task: add the team builder to each framework's Opus app
node harness/run.mjs --task=extend-team --frameworks=all --iterations=3

# Judges (after a run): 6 dimensions x 3 samples per iteration, GLM-5.3 by default
node analysis/judge/judge.mjs runs/<id>
node analysis/judge/judge.mjs --opus            # same rubrics on the Opus apps
node analysis/analyze.mjs runs/<id>             # re-run analyses and rewrite report.md

# Flakiness: re-run each app's final tests twice more in clean containers (adds `Retests`)
node harness/retest.mjs runs/<id> --times=2

# Publish: scrubbed results (GitHub) and traces (Hugging Face), re-scanned for secrets
node scripts/export-results.mjs runs/<id> --name=<name> --results=publish/results --traces=publish/traces
```

The published runs were made with `--frameworks=all --iterations=5 --parallel=8 --cpus=4
--memory=8g` (build), `--task=extend-team --iterations=3 --no-measure` (extension) and judges
at `--per-framework=2 --samples=3` (the 2 apps nearest each framework's median size), on a
48-thread EPYC VPS. The Kimi K3 build added `--model=moonshotai/Kimi-K3 --hf-provider=deepinfra`.

Each run writes `runs/<id>-<task>/report.md` and `summary.json`. `node harness/run.mjs --help`
lists every option (`--model`, `--hf-provider`, `--thinking`, `--max-turns`, `--parallel`, …).

## What's the same as upstream, and what isn't

Unchanged, from `upstream/` (a clone pinned at `b95ada0`): `template/` (spec, API, data,
acceptance tests, design), `Containerfile.base`, `Containerfile.measure`, `measure.mjs`, the
prompt, the framework labels, final tests in a clean container with only `app/`, and
measuring only passing apps.

Changed, because the harness is different:

| | Upstream (Claude Code) | Here (Pi) |
| --- | --- | --- |
| Model | `claude-opus-5-5`, `--effort high` | Default `deepseek-ai/DeepSeek-V4.1-Flash-1017`, pinned to one HF provider (default `together`), `--thinking high`; the published Kimi K3 run is `moonshotai/Kimi-K3` on `deepinfra` |
| Tools | Claude Code's built-ins (incl. WebSearch, WebFetch, subagents) | Pi's `read, bash, edit, write` + `web_search`, `web_fetch` (Exa, `harness/container/pi/extensions/web.ts`) |
| MCP | `--mcp-config`, tools declared directly | Pi's built-in MCP, `exposure: "direct"` so tools are declared directly too (Pi's default hides them behind a scripting tool) |
| Skills | `.claude/skills` via `skills add -a claude-code` | `.agents/skills` via `skills add -a pi`, loaded with `--approve` |
| SvelteKit plugin | MCP + skills + subagent + LSP | MCP + skills (Pi has no subagents; the LSP needs a binary the original image didn't have either) |
| Stop condition | Claude Code finishes; 240 min timeout | Pi finishes; 240 min timeout; 500-turn cap (`run-guard.ts`; Pi has none) |
| Empty completions | n/a | `run-guard.ts` turns a completion with no text or tool call into a provider error, so Pi's auto-retry re-sends the request instead of ending the run. together returned these for Kimi K3 on ~8% of requests, sometimes 5 times running for the same request, so the Kimi grid ran on deepinfra (0 retries) |
| Bash timeout | 2 min default, 10 min max | 5 min default, 10 min max (`run-guard.ts`). Pi's bash otherwise waits forever: an early grid run hung for 11+ min on a busy-looping script. 5 min rather than 2 because Pi's tool description tells the model there is no default |
| Runtime | Podman | Docker (default) or Podman, `--runtime` |
| Agent outputs | Written to a host mount (`/out`) | Written inside the container and copied out with `cp` after it exits; the agent has no writable host mount. An agent that hit a full disk used `df`, found the old `/out` mount and moved the 1.5 GB dataset onto the host through it |
| Images | Anthropic API downsizes to ≤1568 px | Capped to 1568 px / 400 KB in `models.json` (`pin-provider.mjs`): HF providers reject request bodies over a few MB (together: 413 at ~4–5 MB), which otherwise forces overflow compactions after a handful of screenshot reads |
| Image history | All images stay in the request | `image-budget.ts`: when images in a request pass 2.5 MB, the oldest are replaced by a placeholder naming the file, down to 1.5 MB (batched, so the prompt cache survives). The 1M-token context is never the limit; the provider's request-body limit is: one run hit 413 at ~200k tokens with 28 screenshots = 4.8 MB of a 5.5 MB request, and 3 of the first 21 grid runs were forced into compactions |
| Measure DNS | Ubuntu host resolves `*.localhost` | `--add-host` for `app.localhost` / `api.localhost` (Docker's DNS doesn't, so SSR apps returned 500) |
| Cost | Claude Code's API-price report | Pi's estimate from its catalog prices, which charge cached input at $0. Not an invoice: for DeepSeek on together, HF billed about half of Pi's estimate |

## Layout

```
harness/        run.mjs (orchestrator), tasks.mjs, container/ (agent image, entrypoints, Pi config + extensions)
analysis/       analyze.mjs, trace.mjs, code-stats.mjs, report.mjs, judge/ (judge.mjs, rubrics/)
tasks/          extension tasks: FEATURE.md, task.json, tests/, gold/ (reference impl that validates the tests)
baselines/      opus.mjs (Nolan's runs, base-app selection), opus-analysis/ (generated)
upstream/       nolanlawson/agent-framework-benchmark, unmodified
runs/           results (gitignored)
```

### Per-iteration output

| Path | |
| --- | --- |
| `agent/session/*.jsonl` | The full Pi session: thinking, tool calls and results, usage per message |
| `agent/events.jsonl` | Pi's JSON event stream (minus per-token deltas), incl. tool durations |
| `agent/run-info.txt`, `tooling-versions.json`, `mcp.json`, `mcp-status.json` | Versions, MCP config and what connected |
| `agent/final-test.log` | Acceptance tests in a clean container |
| `analysis/trace.json`, `trace.md` | Trace metrics; condensed readable trace |
| `analysis/code.json` | Significant-code stats, per file |
| `analysis/diff.json`, `changes.diff` | Extension tasks: the agent's change to the base app |
| `judge/<dimension>/<n>/verdict.json` | Judge verdicts (+ the judge's own Pi session) |
| `measure/` | Upstream's Lighthouse + LOC results |

To read a session in a browser: `pi --export runs/<id>/<it>/agent/session/<file>.jsonl`.

## Metrics, briefly

**Significant LOC** = script and template lines in non-boilerplate source files, minus
imports, type declarations, comments and bare punctuation/closing tags. CSS, config files
(`*.config.*`, `*.d.ts`, scaffold entry points) and tests are reported separately. JSX and
Lit `html``` literals count as template. `upstreamLoc` reproduces upstream's number (it
matches Nolan's published LOC for the Opus apps).

**Concepts** = distinct framework vocabulary: named imports from packages
(`svelte#onMount`), ambient APIs used without importing them (`$state`, `defineProps`,
`useFetch`, `Astro`), template directives (`bind:`, `v-if`, `@for`, `hx-get`), and file
conventions (`+page.server.ts`, `route [param].tsx`). Ambient detection is heuristic:
identifiers not declared in the file and not JS/DOM globals.

**Trace**: see the header of `analysis/trace.mjs`. Everything there is deterministic; the
`trace` judge adds an LLM read of the condensed trace for circularity, debugging and
verification quality.

**Judges** run Pi read-only (`read, grep, find, ls, web_search, web_fetch` + the framework's
docs MCP and skills, exactly as the agent had them) with an anchored 1–5 rubric. Every score
must cite `app/<file>:<line>` evidence. Default model `zai-org/GLM-5.3` on `together`: a
different model family from the agent, to avoid self-preference. The router's responses name
that model, but HF billing listed the published runs' judge calls as `zai-org/GLM-5.3-Flash`, at
a total that fits Flash's price, so the judge may have been GLM-5.3-Flash. Static-analysis facts are put in the prompt
so the judge doesn't miscount.

## Caveats

- One model, one effort level, one app. Agent runs vary a lot: use 3+ iterations.
- Opus transcripts weren't published, so trace metrics have no Opus baseline; code and judge
  metrics do.
- `agent-browser` ships no Chrome for linux/arm64; on Apple Silicon agents may not have a
  working browser (recorded in the image as `/home/agent/agent-browser-install-failed`).
  Upstream's agents ran on x86_64 Linux.
- Judges are LLMs: read the evidence in `verdict.json`, not just the score.
- Lighthouse numbers depend on the machine. Upstream measured on a Framework 13 laptop; here
  it's a Docker VM on whatever you run it on. Compare frameworks within a run, not against the
  blog post's absolute numbers.
- DeepSeek edits files mostly through bash (`python3 - <<'PY' ... write_text`, `sed -i`)
  rather than Pi's `edit` tool, so tool-level edit metrics undercount; the trace analysis
  counts bash writes separately (`Bash writes`) and uses both for fix cycles.
- Judges can cost more than agents. Pi estimates $0.07–0.13 per verdict with GLM-5.3 (6
  dimensions x 3 samples is roughly $1.80 per app), but HF billed the DeepSeek runs' ~1,000
  verdicts at $20.27, about $0.02 each; a DeepSeek build run was billed at roughly $0.07.

## Smoke test (2026-10-29, Apple Silicon, Docker Desktop)

| Run | Result |
| --- | --- |
| `build` / vanilla | 54/54 tests, 15.7 min, 11.2 M tokens (10.9 M cache reads), $0.22, 180 turns, 2 overflow compactions (before the image cap) |
| `extend-team` / sveltekit (Opus `sveltekit-5` base) | 63/63 tests, no regressions, 2.0 min, $0.05, 9 files changed, read both Svelte skills, ran the Svelte autofixer 4x via CLI, MCP tools connected but unused; Lighthouse perf 100, LCP 1130 ms |
| Judges on vanilla | mergeability 3/5 (found a real crash on `GET /%`), trace 4/5 (~30 wasted turns on CSS tuning) |
