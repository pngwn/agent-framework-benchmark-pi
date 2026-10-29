import { test, expect } from '@playwright/test';
import { main, section, cards, cardFor, expectText, expectHref, rowCells } from './helpers.mjs';

const TYPES = [
  'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
  'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy',
];

const teamButton = (page, name) => main(page).getByRole('button', { name, exact: true });

async function addToTeam(page, species) {
  await page.goto(`/pokemon/${species}`);
  await teamButton(page, 'Add to team').click();
  await expect(teamButton(page, 'Remove from team')).toBeVisible();
}

const coverageRow = (page, type) =>
  section(page, 'Type coverage').getByRole('row').filter({ has: page.getByRole('rowheader', { name: type, exact: true }) });

test.describe('Team', () => {
  test('is linked from the navigation', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Types', exact: true }) });
    await expectHref(nav.getByRole('link', { name: 'Team', exact: true }), '/team');
  });

  test('starts empty', async ({ page }) => {
    await page.goto('/team');
    const m = main(page);
    await expect(m.getByRole('heading', { level: 1 })).toHaveText('Team');
    await expect(page).toHaveTitle('Team – Pokédex');
    await expectText(m, /(^|\s)0 of 6($|\s)/);
    await expect(m.getByText('Your team is empty')).toBeVisible();
    await expectHref(m.getByRole('link').first(), '/');
    await expect(section(page, 'Type coverage')).toHaveCount(0);
  });

  test('adds a Pokémon from its page', async ({ page }) => {
    await addToTeam(page, 'pikachu');
    await page.goto('/team');
    const m = main(page);
    await expectText(m, /(^|\s)1 of 6($|\s)/);
    await expect(cards(m)).toHaveCount(1);
    const card = cardFor(m, /Pikachu/);
    await expectHref(card.getByRole('link').first(), '/pokemon/pikachu');
    await expectText(card, /#0025/);
    await expectText(card, /Electric/);
  });

  test('keeps the order Pokémon were added in, across reloads', async ({ page }) => {
    await addToTeam(page, 'charizard');
    await addToTeam(page, 'pikachu');
    await addToTeam(page, 'mr-mime');
    await page.goto('/team');
    const names = () => cards(main(page)).allInnerTexts().then((t) => t.map((s) => s.match(/Charizard|Pikachu|Mr Mime/)?.[0]));
    await expect.poll(names).toEqual(['Charizard', 'Pikachu', 'Mr Mime']);
    await page.reload();
    await expect.poll(names).toEqual(['Charizard', 'Pikachu', 'Mr Mime']);
    await expectText(main(page), /(^|\s)3 of 6($|\s)/);
  });

  test('removes a Pokémon from the team page', async ({ page }) => {
    await addToTeam(page, 'charizard');
    await addToTeam(page, 'mr-mime');
    await page.goto('/team');
    await main(page).getByRole('button', { name: 'Remove Mr Mime', exact: true }).click();
    await expectText(main(page), /(^|\s)1 of 6($|\s)/);
    await expect(cards(main(page))).toHaveCount(1);
    await page.reload();
    await expect(cardFor(main(page), /Charizard/)).toHaveCount(1);
    await expect(cardFor(main(page), /Mr Mime/)).toHaveCount(0);
  });

  test('removes a Pokémon from its page', async ({ page }) => {
    await addToTeam(page, 'pikachu');
    await teamButton(page, 'Remove from team').click();
    await expect(teamButton(page, 'Add to team')).toBeEnabled();
    await page.goto('/team');
    await expect(main(page).getByText('Your team is empty')).toBeVisible();
  });

  test('holds at most six Pokémon', async ({ page }) => {
    test.setTimeout(60_000);
    for (const species of ['bulbasaur', 'charmander', 'squirtle', 'pikachu', 'eevee', 'mewtwo']) await addToTeam(page, species);
    await page.goto('/pokemon/mew');
    await expect(teamButton(page, 'Add to team')).toBeDisabled();
    await expect(main(page).getByText('Team is full')).toBeVisible();
    await page.goto('/pokemon/pikachu');
    await expect(teamButton(page, 'Remove from team')).toBeEnabled();
    await expect(main(page).getByText('Team is full')).toHaveCount(0);
    await page.goto('/team');
    await expectText(main(page), /(^|\s)6 of 6($|\s)/);
  });

  test('shows type coverage', async ({ page }) => {
    await addToTeam(page, 'pikachu');
    await addToTeam(page, 'charizard');
    await page.goto('/team');
    const table = section(page, 'Type coverage').getByRole('table');
    await expect(table.getByRole('rowheader')).toHaveText(TYPES);
    await expect(table.getByRole('columnheader')).toHaveText(['Type', 'Weak', 'Resistant']);
    // [weak, resistant] for Pikachu (Electric) + Charizard (Fire/Flying).
    const expected = {
      Ground: ['1', '1'], // Pikachu x2, Charizard x0 (Flying is immune)
      Rock: ['1', '0'], // Charizard x4
      Water: ['1', '0'],
      Electric: ['1', '1'], // Charizard x2, Pikachu x0.5
      Grass: ['0', '1'], // Charizard x0.25
      Ice: ['0', '0'], // Charizard x2 x0.5 = 1
      Steel: ['0', '2'],
      Flying: ['0', '1'],
      Fighting: ['0', '1'],
      Normal: ['0', '0'],
      Fire: ['0', '1'],
    };
    for (const [type, [weak, resistant]] of Object.entries(expected)) {
      await expect.poll(() => rowCells(coverageRow(page, type)), { message: type }).toEqual([type, weak, resistant]);
    }
  });

  test('uses live API data', async ({ page }) => {
    // Benchmon (Normal) only exists in the live-data overlay, not at build time.
    await addToTeam(page, 'benchmon');
    await page.goto('/team');
    await expectText(cardFor(main(page), /Benchmon/), /Normal/);
    await expect.poll(() => rowCells(coverageRow(page, 'Fighting'))).toEqual(['Fighting', '1', '0']);
    await expect.poll(() => rowCells(coverageRow(page, 'Ghost'))).toEqual(['Ghost', '0', '1']);
  });
});
