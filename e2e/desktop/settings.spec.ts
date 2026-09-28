import { expect, test, type Page } from '@playwright/test';

/**
 * The settings of a desktop install, which is an install whose data is on this
 * machine — and that is what decides what is worth asking in it.
 *
 * An engine it cannot reach, a store there is only one of, and a password for a
 * door only this app opens: none of them is a question here, so none of them is
 * on the page. What is left is asked for, and what is left out is not.
 */
const openSettings = async (page: Page): Promise<void> => {
  await page.goto('/settings');

  // Waited out rather than assumed: this is a dev server, and the first render
  // of a route it has not compiled yet takes seconds on a runner that is slower
  // than a laptop — and the panel is drawn from an answer the page fetches.
  await expect(page.getByText('Local port', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
};

test.describe('Desktop settings', () => {
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

  test('asks nothing about web search', async ({ page }) => {
    await openSettings(page);

    // CodeBuddy is the only engine an install whose data is here can reach, so
    // there is no engine to choose between and no key of the user's to ask for
    // — and the config fields of an engine that cannot be chosen go with it.
    await expect(page.locator('#CODEBUDDY_WEB_SEARCH_BACKEND')).toHaveCount(0);
    await expect(page.getByText('Web search backend')).toHaveCount(0);
  });

  test('offers only the backends a fetch from this machine can use', async ({
    page,
  }) => {
    await openSettings(page);

    const picker = page.locator('#CODEBUDDY_WEB_FETCH_BACKEND');

    await expect(picker).toBeVisible();
    await picker.click();

    // CodeBuddy, and this server fetching the page itself: nothing that needs a
    // key, or a browser somewhere else, to answer.
    await expect(page.getByRole('option', { name: 'CodeBuddy' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Local' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Jina Reader' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('option', { name: 'Browserable' })).toHaveCount(
      0,
    );
  });

  test('offers no choice of where its data is kept', async ({ page }) => {
    await openSettings(page);

    // This machine is the only place the data can be, so a menu with a single
    // disabled entry in it is not a menu.
    await expect(page.locator('#desktopStorageBackend')).toHaveCount(0);
    await expect(page.getByText('Storage backend')).toHaveCount(0);
    await expect(page.getByText('Desktop app')).toBeVisible();
  });

  test('leaves the appearance and the language to the menu bar item', async ({
    page,
  }) => {
    await openSettings(page);

    // The window is dressed by the desktop, and so are its controls: the menu
    // bar item is where those two are chosen on a desktop install, and a second
    // place to choose them is a second answer to one question.
    await expect(page.locator('.admin-header-brand')).toHaveCount(0);
    await expect(page.getByLabel('Language')).toHaveCount(0);
    await expect(page.getByLabel('Theme mode')).toHaveCount(0);
  });
});
