import { expect, test } from '@playwright/test';

test('the app loads with its title and the Atrium tokens', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page).toHaveTitle('Proposal Development Tool');
  await expect(page.locator('#root')).toBeAttached();

  const background = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim());
  expect(background, 'the --background token from src/styles/tokens.css').not.toBe('');

  expect(errors, 'uncaught page errors').toEqual([]);
});
