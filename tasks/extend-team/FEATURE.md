# Feature: Team builder

Add a team builder to the existing Pokédex app in `app/`. Everything in `SPEC.md` still
applies, and every existing test must keep passing. Keep using the app's framework and
follow its existing conventions; it's your codebase now.

A team is up to **6** Pokémon species the user has picked, in the order they were added,
with no duplicates. It belongs to the browser: it survives reloads and navigation, with no
accounts or server-side user storage beyond what the browser sends (cookies and
`localStorage` are both fine). The Pokémon data shown on team pages still comes from the
API at request time, like everywhere else.

## Every page

- The `navigation` landmark gets a third link, `Team`, to `/team`.

## `/pokemon/:name` – Pokémon page

- Near the top (not in a section), a button:
  - `Add to team` when the species isn't on the team. Activating it adds the species to the
    end of the team.
  - `Remove from team` when it is. Activating it removes it.
  - When the team is full and the species isn't on it, `Add to team` is disabled and the
    text `Team is full` is shown next to it.
- The button reflects the team as soon as the page shows (no flash of the wrong label
  that a test could observe after the page has loaded), and updates without leaving the
  page or after a reload of the same URL, whichever your architecture prefers.

## `/team` – Team page

- `h1`: `Team`. Document title: `Team – Pokédex`.
- The text `<n> of 6`, the number of species on the team.
- With an empty team: the text `Your team is empty` and a link to `/`, and no `Type
  coverage` section.
- Otherwise a list of Pokémon cards (as defined in `SPEC.md`, **including the types**, like
  on the home page) in the order they were added. Each list item also has a button named
  `Remove <humanized name>` (`Remove Mr Mime`) that removes that species from the team.
- Section `Type coverage`: a `table` with one row for each of the 18 types, in API order,
  treating that type as the attacking type. Columns, in order:
  - `Type`: a row header with the type's English name.
  - `Weak`: how many team members take more than normal damage from it.
  - `Resistant`: how many take less than normal damage from it, including immunities.
  - Damage is the product of the attacking type's multiplier against each of the member's
    types (`double_damage_to` = 2, `half_damage_to` = ½, `no_damage_to` = 0, otherwise 1),
    using the member's default Pokémon's types. A Fire/Flying Pokémon takes 2 × ½ = 1 from
    Ice, so it is neither weak nor resistant to it.
