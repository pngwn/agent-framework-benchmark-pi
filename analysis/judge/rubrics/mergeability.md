---
title: Mergeability
extra: {}
---
# Dimension: mergeability

Would you merge this as-is into a team codebase? Judge idiom and local quality, and look
hard for abstractions that are fine where they sit but cause problems across the codebase.

## Criteria

**`idiomatic`** — Uses the framework the way its current docs and official skills say to.
- 5: Reads like the framework's own examples; data loading, routing, rendering and state
  use the recommended primitives.
- 3: Works and is recognisably idiomatic, with a few home-grown workarounds where a
  framework feature exists.
- 1: Fights the framework: reimplements routing/data loading/reactivity by hand, or uses
  patterns the docs warn against.

**`correctness_risks`** — Bugs and fragility the tests didn't catch: race conditions, unhandled
errors and rejections, missing 404 handling, unescaped HTML, unbounded caches or fetch fan-out,
SSR/CSR mismatches, leaked listeners.
- 5: None found after a careful look. 3: A few minor ones. 1: Several, or one serious.

**`global_abstractions`** — Abstractions that are locally reasonable but globally
problematic: a "utils" module everything depends on, a god component or god data module,
premature generic layers, duplicated near-identical helpers, hidden global state or
caches, config buried in code, leaky boundaries between server and client code.
- 5: Abstractions are few, earn their keep and have clear boundaries.
- 3: One or two that will need untangling later.
- 1: The structure itself is the problem.

**`readability`** — Naming, file organisation, function size, comments that explain why,
consistency across files.
- 5: A new teammate finds their way in minutes. 3: Fine with some rough spots. 1: Hard to follow.

**`review_cost`** — How much a reviewer would have to ask to change before approving.
- 5: Approve. 4: Nits. 3: A round of changes. 2: Significant rework. 1: Reject.
