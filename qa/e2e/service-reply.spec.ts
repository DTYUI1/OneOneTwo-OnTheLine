import { expect } from "@playwright/test";
import { test, login } from "./captain-fixture";

// Проверка реального браузерного пути: микрофон слышит доклад и тишину,
// служба подтверждает приём без ручного отбоя. Звук микрофона синтетический:
// тест не зависит от гарнитуры машины и разрешений ОС.
test("Общий номер 102 отвечает после доклада и паузы", async ({
  page,
  lesson,
}) => {
  test.skip(process.env.E2E_DATABASE !== "1", "Нужен стенд с базой данных");
  test.setTimeout(90_000);
  await login(page, "trainee05");
  await page.locator(`[data-card-id="${lesson.card.id}"]`).click();

  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const volume = context.createGain();
      const destination = context.createMediaStreamDestination();
      tone.frequency.value = 440;
      volume.gain.value = 0.08;
      tone.connect(volume).connect(destination);
      tone.start();
      setTimeout(() => tone.stop(), 3500);
      return destination.stream;
    };
  });

  await page.getByRole("button", { name: "Телефон", exact: true }).click();
  for (const digit of "102")
    await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Вызов", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Разговор", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Звонок завершён", exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(async () => {
      const events = (await (
        await page.request.get(`/api/cards/${lesson.card.id}/events`)
      ).json()) as { type: string }[];
      return events.map((event) => event.type);
    })
    .toContain("call_hangup");

  // Окно разговора показывает обмен целиком: реплику службы и отбой.
  const talk = page.getByRole("region", { name: /^Разговор: / });
  await expect(talk.getByText(/информация принята/)).toBeVisible();
  await expect(talk.getByText(/Абонент положил трубку/)).toBeVisible();
  await talk.getByRole("button", { name: "Закрыть окно разговора" }).click();

  const services = (await (await page.request.get("/api/services")).json()) as {
    id: string;
    name: string;
  }[];
  const service = services.find((item) => item.id === "102")!;
  const card = page.getByRole("region", {
    name: `Происшествие ${lesson.card.source.number}`,
    exact: true,
  });
  await card
    .getByRole("button", { name: `Развернуть ${service.name}`, exact: true })
    .click();
  async function status(state: string) {
    await card.getByRole("button", { name: "Изменить статус" }).click();
    await card.getByLabel("Статус", { exact: true }).selectOption(state);
    await card
      .getByLabel("Комментарий", { exact: true })
      .fill("Проверка статуса");
    await card.getByRole("button", { name: "Подтвердить" }).click();
  }
  await status("accepted");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/cards/${lesson.card.id}`)).json())
          .state,
    )
    .toBe("accepted");
  await status("completed");
  await expect(card.getByText(/Нажмите ✓ ещё раз/)).toBeVisible();
  expect(
    (await (await page.request.get(`/api/cards/${lesson.card.id}`)).json())
      .state,
  ).toBe("accepted");
  await card.getByRole("button", { name: "Подтвердить" }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/cards/${lesson.card.id}`)).json())
          .state,
    )
    .toBe("completed");
});
