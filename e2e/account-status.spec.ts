import { expect, test } from '@playwright/test';

test.describe('Account Status tab', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: 'codebuddy2api-locale',
        value: 'en-US',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
  });

  test('navigates to the tab and shows the empty state', async ({ page }) => {
    await page.goto('/account-status');

    await expect(
      page.getByRole('button', { name: 'Account Status' }),
    ).toBeVisible();
    await expect(page.getByText('No credentials')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Refresh all' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Check in all' }),
    ).toBeVisible();
  });

  test('keeps the account status layout usable on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/account-status');

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expect(page.getByText('No credentials')).toBeVisible();
  });
});
