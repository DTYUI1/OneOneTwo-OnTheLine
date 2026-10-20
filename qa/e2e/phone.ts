import { expect, type Locator, type Page } from "@playwright/test";

// GP-09: связь службы — окно телефона ДДС (макет docs/dds_training_review/phone/index.html).
// Значок с трубкой на панели открывает окно; контакты — кнопки «Позвонить: <имя>» группами
// (силы службы, руководство и аварийная бригада, службы); разговор идёт в том же окне,
// состояние линии — `data-call-state` у заголовка окна (dialing, ringing, talking, ended).

/** Окно телефона ДДС: контакты без звонка, разговор во время звонка. */
export function phoneWindow(page: Page): Locator {
  return page.getByRole("region", { name: "Телефон ДДС" });
}

/** Заголовок окна во время звонка: `data-call-state` — состояние линии. */
export function callHead(win: Locator): Locator {
  return win.locator("h2[data-call-state]");
}

/** Открыть и развернуть окно телефона значком на панели. */
export async function openPhone(page: Page): Promise<Locator> {
  const win = phoneWindow(page);
  if (!(await win.isVisible())) await phoneButton(page).first().click();
  await expect(win).toBeVisible();
  const expand = win.getByRole("button", { name: "Развернуть телефон" });
  if (await expand.isVisible()) await expand.click();
  return win;
}

/**
 * Открыть вкладку набора номера («Справочник» и «Набор» — вкладки окна, правка 19.10):
 * поле «Номер» и клавиатура видны только на ней.
 */
export async function openDial(win: Locator): Promise<Locator> {
  const tab = win.getByRole("tab", { name: "Набор" });
  if (await tab.isVisible()) await tab.click();
  return win.getByRole("textbox", { name: "Номер" });
}

/** Кнопка контакта по имени: «Позвонить: Скорая помощь 103». */
export function contact(win: Locator, name: string | RegExp): Locator {
  return win.getByRole("button", {
    name:
      typeof name === "string"
        ? `Позвонить: ${name}`
        : new RegExp(`^Позвонить: ${name.source.replace(/^\^/, "")}`),
  });
}

/** Позвонить контакту и дождаться разговора. Возвращает окно телефона. */
export async function dial(
  page: Page,
  name: string | RegExp | Locator,
): Promise<Locator> {
  const win = await openPhone(page);
  const target = typeof name === "object" && "click" in name ? name : null;
  await (target ?? contact(win, name as string | RegExp)).click();
  await expectTalking(win);
  return win;
}

/** Первая свободная бригада своей службы в контактах. */
export function freeBrigade(win: Locator): Locator {
  return win.locator('button[data-state="free"]').first();
}

export async function expectTalking(win: Locator): Promise<void> {
  await expect(callHead(win)).toHaveAttribute("data-call-state", "talking", {
    timeout: 20_000,
  });
}

/** Звонок окончен: окно показывает итог, «Перезвонить» и «К контактам». */
export async function expectEnded(win: Locator, timeout = 20_000) {
  await expect(callHead(win)).toHaveAttribute("data-call-state", "ended", {
    timeout,
  });
}

/**
 * Текущий шаг ответа по частям в полосе шагов окна («2. Адрес»). Пояснение «Доклад по
 * частям, шаг …» прячется, когда обучаемый его освоил (GP-24), — шаг ищем здесь.
 */
export function currentStep(win: Locator, label: string): Locator {
  return win.locator('[data-current="true"]', {
    hasText: new RegExp(`^\\d+\\. ${label}$`),
  });
}

/** Кнопки ответа в разговоре: реплики, части доклада и вводной, «Говорить». */
export function answer(win: Locator): Locator {
  return win.getByRole("group", { name: "Ответ" });
}

/** Итог звонка закрыт: окно снова показывает контакты. */
export async function backToContacts(win: Locator): Promise<void> {
  await answer(win)
    .getByRole("button", { name: "К контактам", exact: true })
    .click();
  await expect(callHead(win)).toHaveCount(0);
}

/** Закрыть окно телефона рамкой «Закрыть»: оно не заслоняет карточку. */
export async function closePhone(page: Page): Promise<void> {
  const win = phoneWindow(page);
  if (!(await win.isVisible())) return;
  await win.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(win).toBeHidden();
}

/** Набрать номер вручную в поле «Номер» и дождаться разговора. */
export async function dialTyped(page: Page, number: string): Promise<Locator> {
  const win = await openPhone(page);
  await (await openDial(win)).fill(number);
  await win.getByRole("button", { name: "Позвонить", exact: true }).click();
  await expectTalking(win);
  return win;
}

/**
 * Значок IP-телефона на панели ДДС (рекомендации 16.10, п. 8): на странице или внутри
 * `scope`, например в полосе «Службы:» карточки.
 */
export function phoneButton(scope: Page | Locator): Locator {
  return scope.getByRole("button", { name: /^Телефон(: входящих \d+)?$/ });
}

/**
 * Вкладки линий на плашке звонков (проверка 17.10): идущий разговор (`active`), линии на
 * удержании (`held`), входящие вызовы (`ringing`), «не дождался на удержании» (`dropped`).
 * Подпись вкладки — кто («Старший бригады · 201», «Служба 101», «Отдел контроля»), что с
 * линией («звонит 0:12», «на удержании 0:42») и «по карточке N», если вкладке хватает места.
 */
export function lineTab(
  win: Locator,
  line: "active" | "held" | "ringing" | "dropped",
  who?: string | RegExp,
): Locator {
  const tabs = win.locator(`[role="tab"][data-line="${line}"]`);
  return who ? tabs.filter({ hasText: who }) : tabs;
}

/** Ответить на входящий вызов — щелчком по его вкладке; идущий разговор встаёт на удержание. */
export async function answerRing(
  win: Locator,
  who?: string | RegExp,
): Promise<void> {
  await lineTab(win, "ringing", who).first().click();
}

/**
 * Собеседник в разговоре договорил: индикатор голоса погас. «Говорить» доступна и пока он
 * говорит — нажатие ждёт конца реплики (HQ-052), поэтому «ваша очередь» — по индикатору.
 */
export async function peerDone(win: Locator, timeout = 20_000): Promise<void> {
  await expect(win.locator('[data-speaking="false"]')).toBeVisible({
    timeout,
  });
}
