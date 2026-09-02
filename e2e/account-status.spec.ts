import { expect, test } from '@playwright/test';

test.describe('Account Status tab', () => {
  test('navigates to the tab and shows the empty state', async ({ page }) => {
    await page.goto('/account-status');

    await expect(page.getByText('账号状态', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无凭据')).toBeVisible();
    await expect(page.getByRole('button', { name: '刷新全部' })).toBeVisible();
    await expect(page.getByRole('button', { name: '全部签到' })).toBeVisible();
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
    await expect(page.getByText('暂无凭据')).toBeVisible();
  });
});
