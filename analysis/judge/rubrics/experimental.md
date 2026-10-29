---
title: Experimentalness
extra: |
  "experimentalApis": [{ "api": "name", "location": "app/...:1", "status": "experimental|preview|release-candidate|canary|recently-stable", "since": "version or date if known", "source": "where you confirmed the status" }],
  "count": 0
---
# Dimension: experimentalness

How often does the code reach for new or experimental APIs? This is descriptive, not a
quality score: leaning on experimental APIs can be a strength (using where the framework is
going) or a risk (breaking changes). Record what's there and how risky it is.

Start from the measured `experimental` markers in the facts (config flags and
`unstable_`/`experimental_` names), then look further: APIs documented as experimental,
preview, beta, release candidate, canary-only, or stable only in the last ~6 months.
Confirm each status against the framework's docs or release notes and cite the source.

## Criteria

**`reach`** — How much the app relies on experimental or very new APIs.
- 5: Several central features rest on experimental/preview APIs or flags.
- 3: One or two, or recently-stable APIs in central places.
- 1: Only long-stable APIs.

**`containment`** — When it does use them, are they isolated so they're easy to swap if
they change (behind a module, a wrapper or one route), or spread throughout?
- 5: Contained, or nothing to contain. 3: Partly. 1: Spread through many files.

**`justification`** — Does each experimental API buy something a stable API couldn't
(performance, simpler code, a spec requirement)?
- 5: Every use is justified, or none are used. 3: Some are gratuitous. 1: Mostly novelty.

Set `count` to the number of distinct experimental/preview/RC/canary APIs (not counting
"recently-stable" ones).
