import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, account = 'trainee01') {
  await page.goto('/app/login');
  await page.getByLabel('Логин', { exact: true }).fill(account);
  await page.getByLabel('Пароль').fill(process.env.DEMO_PASSWORD ?? 'demo-local');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/arm$/);
}

test('Первое знакомство: клавиатура, мобильный экран и повторный вход', async ({ page }, testInfo) => {
  await login(page);
  const greeting = page.getByRole('heading', { name: 'Выберите обучение' });
  await expect(greeting).toBeVisible();
  await expect(greeting).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Список происшествий' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('welcome-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('welcome-mobile.png'), fullPage: true });
  // Не считаем приветствие прочитанным, пока пользователь не нажал кнопку.
  await page.reload();
  await expect(greeting).toBeFocused();
  // Первая плитка — «112» (оператор), вторая — диспетчер служб.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Оператор 112' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Диспетчер служб' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Список происшествий' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Список происшествий' })).toBeVisible();
  await expect(greeting).toHaveCount(0);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/login$/);
  await login(page);
  // Выбор обучения — при каждом входе обучаемого, а не только при первом.
  await expect(greeting).toBeVisible();
  await page.getByRole('button', { name: 'Диспетчер служб' }).click();
  await expect(page.getByRole('heading', { name: 'Список происшествий' })).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/login$/);
  await login(page, 'trainee02');
  await expect(greeting).toBeVisible();
});

test('Недоступный localStorage не мешает пройти приветствие', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage disabled', 'SecurityError'); },
    });
  });
  await login(page);
  await page.getByRole('button', { name: 'Диспетчер служб' }).click();
  await expect(page.getByRole('heading', { name: 'Список происшествий' })).toBeVisible();
});
