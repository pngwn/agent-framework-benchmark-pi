---
title: Forward-thinking
extra: |
  "apis": [{ "api": "name", "location": "app/...:1", "status": "current|legacy|deprecated", "replacement": "what's current, if legacy" }],
  "dependencies": [{ "name": "pkg", "verdict": "modern|established|bloated|outdated|unnecessary", "note": "why" }]
---
# Dimension: forward-thinking

Will this code age well? Check whether it uses the framework's latest APIs rather than
older ones that are still supported, whether it's set up to avoid churn when the framework
or requirements move, and whether its dependencies are modern and lean.

Before marking any API legacy or deprecated, confirm it against the framework's docs, a
skill file, release notes or a web search, and cite the source in `rationale`.

## Criteria

**`latest_apis`** — Prefers the current generation of the framework's APIs (for example the
current reactivity model, data-loading primitive, router API, component syntax) over
older, still-supported ones.
- 5: Consistently current, including newer APIs released after most training data.
- 3: Mostly current with some legacy patterns where a current one exists.
- 1: Predominantly legacy-era APIs.

**`platform`** — Uses modern web platform and language features where they're the better
choice (fetch/streams, URL/URLSearchParams, `AbortController`, native `<dialog>`, CSS nesting
or custom properties, ES modules, top-level await, `structuredClone`, …) instead of
polyfills or hand-rolled versions.
- 5: Reaches for the platform first. 3: Mixed. 1: Ignores it.

**`dependencies`** — Every dependency is needed; where one is needed, it's a modern,
well-maintained, small one rather than an old, heavy or poorly performing default.
Fewer is better when the platform or framework covers it.
- 5: Minimal and modern. 3: One or two questionable picks. 1: Heavy, outdated or redundant packages.

**`churn_resistance`** — Constructs that reduce future churn: types at boundaries, data
access behind one well-defined module, configuration in one place, no reliance on
framework internals or undocumented behaviour, no copy-pasted framework boilerplate that a
newer release would generate differently.
- 5: Upgrading the framework or the API would touch few files. 1: Upgrades would ripple everywhere.
