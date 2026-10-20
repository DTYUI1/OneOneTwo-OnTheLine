import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";
import { lesson, waitCard } from "./memo-lesson";

// Срочность норматива (TC-06) — подсказка обучения (решение 17.10): «Принята» ждёт с тремя
// стадиями и сигналами — только во «Вместе», в подсказке у строки статуса
// (trainer-zone.spec.ts, tutor-pointer.spec.ts). Здесь — тест: занятие преподавателя. Строки
// «Принята» ждёт нет ни до норматива, ни после, сигналов срочности (660 и 330 Гц) нет. Вид
// АРМ не меняется.
test.skip(
  process.env.E2E_DATABASE !== "1",
  "Нужен стенд с базой: E2E_DATABASE=1",
);

test("на занятии «Принята» ждёт нет: ни строки, ни сигналов", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // Web Audio: считаем частоты запущенных тонов — звука в браузере теста не слышно.
  await page.addInitScript(() => {
    const heard: number[] = [];
    Object.assign(window, { heard });
    const original = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const oscillator = original.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (when?: number) => {
        heard.push(oscillator.frequency.value);
        start(when);
      };
      return oscillator;
    };
  });
  const current = await lesson(request, "102");
  try {
    await login(page, "trainee05");
    const card = await waitCard(page, current.id);
    await expect(page.locator(`[data-card-id="${card.id}"]`)).toBeVisible();
    // Сигнал новой карточки (880 Гц) звучит — считаем только сигналы срочности.
    const tones = () =>
      page.evaluate(() =>
        (window as unknown as { heard: number[] }).heard.filter(
          (hz) => hz === 660 || hz === 330,
        ),
      );
    // Норматив 30 с прошёл с запасом — ни строки, ни стадий, ни сигналов.
    await page.waitForTimeout(40_000);
    await expect(page.getByText(/«Принята» ждёт/)).toHaveCount(0);
    await expect(page.locator("[data-urgency]")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Подсказка тренажёра" }),
    ).toHaveCount(0);
    expect(await tones()).toEqual([]);
  } finally {
    await current.finish();
  }
});
