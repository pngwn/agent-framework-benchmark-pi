---
title: Test quality
extra: |
  "wroteTests": true,
  "testCount": 0,
  "valuableTests": ["test name — what regression it would catch"],
  "lowValueTests": ["test name — why it's low value (trivial, tests the framework, duplicates others, asserts implementation details)"],
  "untested": [{ "area": "what isn't tested", "risk": "high|medium|low", "likelyBug": "the kind of bug that would slip through" }]
---
# Dimension: test quality

The agent was given acceptance tests in `tests/` (not its own work) and told to make them
pass. Did it also write tests of its own in `app/`, and are they any good? Measured counts
are in the facts (`tests`). Whether or not it wrote tests, the most useful part of this
review is **what isn't tested and which bugs that will let through** once the acceptance
suite is no longer the only guard (say, when someone refactors the data layer).

If there are no tests in `app/`, score `coverage_of_risk` and `regression_power` on what
would be caught (1), set `wroteTests` false, and spend your effort on `untested`: read the
riskiest code (data transformation, sorting, filtering, pagination, URL state, caching,
error handling) and say what bugs it could hide.

## Criteria

**`coverage_of_risk`** — Tests concentrate on the logic most likely to break: data
transformation, filtering/sorting/pagination, URL state, error and not-found paths.
- 5: The riskiest logic is covered. 3: Some risky logic covered, some not. 1: None or trivial only.

**`behaviour_not_implementation`** — Tests assert observable behaviour (inputs and outputs,
rendered roles and text) rather than internals (private functions, component state, call
counts, snapshots of markup).
- 5: Behavioural throughout. 3: Mixed. 1: Mostly implementation details, or no tests.

**`regression_power`** — Would these tests fail if someone broke the behaviour? Consider
assertions that are too loose, tests that can't fail, and heavy mocking.
- 5: Breaking any covered behaviour fails a test. 3: Some gaps. 1: They'd mostly still pass.

**`signal_to_noise`** — Few low-value tests (trivial getters, framework behaviour,
duplicated cases); each test earns its maintenance cost.
- 5: Lean and purposeful. 3: Some padding. 1: Mostly noise. (No tests: 3.)
