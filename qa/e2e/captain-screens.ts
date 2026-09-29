import { expect, type Page } from "@playwright/test";
import { login } from "./captain-fixture";

/** Один маршрут обхода для проверки справки и видимых русских текстов. */
export async function visitTeacher(
  page: Page,
  title: string,
  check: (name: string) => Promise<void>,
) {
  await login(page, "teacher");
  await page.getByRole("button", { name: "На главную", exact: true }).click();
  await check("Главная преподавателя");
  await page
    .getByRole("button", { name: "+ Новое занятие", exact: true })
    .click();
  await check("Создание занятия");
  if (!(await page.getByRole("button", { name: title }).isVisible()))
    await page.getByRole("button", { name: /^Показать завершённые/ }).click();
  await page.getByRole("button", { name: title }).click();
  for (const tab of ["Состав и раздача", "Ход занятия", "Вердикты", "Отчёт"]) {
    const tabButton = page.getByRole("tab", {
      name: new RegExp(`^${tab}(?:\\s*\\d+)?$`),
    });
    await tabButton.click();
    await expect(tabButton).toHaveAttribute("aria-selected", "true");
    await check(`Занятие: ${tab}`);
  }
  await page.getByRole("button", { name: /^Студия сценариев/ }).click();
  await check("Студия сценариев");
  const tabs = page
    .getByRole("tablist", { name: "Статус сценариев" })
    .getByRole("tab");
  for (let index = 0; index < (await tabs.count()); index++) {
    await tabs.nth(index).click();
    await check(`Студия: ${await tabs.nth(index).innerText()}`);
  }
  await page
    .getByRole("button", { name: "+ Новый сценарий", exact: true })
    .click();
  await check("Редактор сценария");
  await page.getByRole("button", { name: "Материалы", exact: true }).click();
  await check("Материалы преподавателя");
}

export async function visitAdmin(
  page: Page,
  check: (name: string) => Promise<void>,
) {
  await login(page, "admin");
  for (const section of [
    "Состояние системы",
    "Нормативы и оценка",
    "Пользователи",
    "Службы ДДС",
    "Сообщения об ошибках",
  ]) {
    await page.getByRole("button", { name: section, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: section, exact: true }),
    ).toBeVisible();
    await check(`Администратор: ${section}`);
  }
}
