---
title: Editability
extra: |
  "scenarios": [{ "change": "the scenario", "files": ["app/..."], "difficulty": 1, "notes": "what makes it easy or hard" }]
---
# Dimension: editability

How easy is this code to change, remove and extend? Work through these concrete scenarios
by finding every file you'd have to touch, then score. Put each one in `scenarios`, with
the files and a 1–5 difficulty (5 = trivial, 1 = painful).

1. **Remove a feature**: drop the Abilities pages and every link to them.
2. **Fix a bug**: Pokémon cards show the wrong sprite for species whose default Pokémon has
   a different name (e.g. Deoxys). Where would the fix go, and would one fix cover every
   list of cards?
3. **Extend a feature**: add sorting by name to every list of Pokémon cards.
4. **Extend an abstraction**: add an Items section (`/items`, `/items/:name`) shaped like
   Moves. How much of the Moves code can be reused rather than copied?
5. **Change a data source**: the API base URL and caching rules change. How many places know
   about them?

## Criteria

**`removability`** — Features are self-contained; deleting one doesn't mean editing
unrelated files or leaving dead code behind.
- 5: Delete a route/directory and a nav link. 3: A handful of scattered edits. 1: Entangled.

**`changeability`** — A bug fix or behaviour change lands in one obvious place.
- 5: One place, obvious. 3: A few places, findable. 1: Duplicated logic means fixing it N times.

**`coupling`** — Components and modules depend on narrow interfaces rather than each
other's internals; shared state is explicit; server and client code are clearly separated.
- 5: Loosely coupled with clear seams. 3: Some tangles. 1: Everything knows about everything.

**`abstraction_design`** — The abstractions (components, data helpers, layouts) can
stretch to similar-but-different cases without being copied or growing flag parameters.
- 5: Designed around the real variation in the app. 3: Some copy-paste or boolean-flag
  creep. 1: Either none (everything inlined and duplicated) or over-general and awkward.
