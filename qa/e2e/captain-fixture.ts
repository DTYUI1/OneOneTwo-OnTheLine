import { randomUUID } from "node:crypto";
import { expect, test as base, type Page } from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";
import { introSeenForAnyUser } from "./trainer";
type Card = components["schemas"]["Card"];
type Session = components["schemas"]["Session"];
type Scenario = components["schemas"]["Scenario"];

/**
 * Приветствие при первом знакомстве есть у всех ролей (28.09): у преподавателя и
 * администратора — кнопка «Начать работу». Повторный вход в том же браузере его
 * уже не показывает, поэтому ждём либо приветствие, либо шапку приложения.
 */
export async function passWelcome(page: Page) {
  const start = page.getByRole("button", {
    name: /^(Начать работу|Диспетчер служб|Перейти в тренажёр)$/,
  });
  await expect(
    start.or(page.getByRole("button", { name: "Выйти", exact: true })),
  ).toBeVisible();
  if (await start.isVisible()) await start.click();
}

export async function login(page: Page, name: string) {
  // Окно «Как устроено обучение» (DT-18) — перед первой тренировкой; здесь о другом.
  await page.addInitScript(introSeenForAnyUser);
  await page.addInitScript(() => {
    try {
      // Узкие окна проверок не должны упираться в «Рабочее место — для большого экрана».
      sessionStorage.setItem("narrow:open", "1");
    } catch {
      // Без хранилища окно покажется — проверки ниже его не ждут.
    }
  });
  await page.goto("/app/login");
  await page.getByLabel("Логин", { exact: true }).fill(name);
  await page
    .getByLabel("Пароль")
    .fill(process.env.DEMO_PASSWORD ?? "demo-local");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
  await passWelcome(page);
}

type PhoneContact = components["schemas"]["PhoneContact"];

export const test = base.extend<{
  hintsLevel: number;
  secondCard: boolean;
  /**
   * Абоненты телефона ДДС на занятии по службе (GP-09); null — список по умолчанию.
   * Объект, а не массив: массив Playwright принял бы за пару «значение, опции».
   */
  phoneContacts: Record<string, PhoneContact[]> | null;
  lesson: {
    session: Session;
    card: Card;
    issue: () => Promise<Card>;
    finish: () => Promise<void>;
  };
}>({
  hintsLevel: [1, { option: true }],
  secondCard: [false, { option: true }],
  phoneContacts: [null, { option: true }],
  // Занятие фикстуры — параллельное (parallel_cards 3, уровень 4), и АРМ один раз
  // предупреждает об этом окном (ParallelNotice). Эти проверки не о нём: окно
  // закрывается «Понятно», как только появляется. Само окно — parallel-shift.spec.ts.
  page: async ({ page }, use) => {
    await page.addLocatorHandler(
      page.getByRole("dialog", { name: "Параллельная работа" }),
      async (dialog) => {
        await dialog.getByRole("button", { name: "Понятно" }).click();
      },
    );
    await use(page);
  },
  lesson: async (
    { request, page, hintsLevel, secondCard, phoneContacts },
    use,
  ) => {
    expect(
      (
        await request.post("/api/auth/login", {
          data: {
            login: "teacher",
            password: process.env.DEMO_PASSWORD ?? "demo-local",
          },
        })
      ).ok(),
    ).toBeTruthy();
    const headers = {
      "X-CSRF-Token": (await request.storageState()).cookies.find(
        (c) => c.name === "csrf",
      )!.value,
    };
    const users: components["schemas"]["User"][] = await (
      await request.get("/api/users")
    ).json();
    const user = users.find((u) => u.login === "trainee05")!;
    const scenarios: Scenario[] = await (
      await request.get("/api/scenarios")
    ).json();
    const source =
      scenarios.find((s) => s.id === "00000000-0000-4000-8000-000000000100") ??
      scenarios.find((s) => s.status === "approved")!;
    const scenario = {
      ...source,
      id: randomUUID(),
      card: {
        ...source.card,
        number: `7${Date.now().toString().slice(-7)}`,
        incident_class: `Учебное происшествие ${Date.now()}`,
      },
    };
    expect(
      (
        await request.post("/api/scenarios", { headers, data: scenario })
      ).status(),
    ).toBe(201);
    let session: Session | undefined;
    let finished = false;
    const finish = async () => {
      if (session && !finished) {
        expect(
          (
            await request.post(`/api/sessions/${session.id}/finish`, {
              headers,
            })
          ).ok(),
        ).toBeTruthy();
        finished = true;
      }
    };
    try {
      const settings = await (await request.get("/api/settings")).json();
      const created = await request.post("/api/sessions", {
        headers,
        data: {
          title: `Проверка интерфейса ${Date.now()}`,
          participants: [
            {
              user_id: user.id,
              workstation_number: 23,
              dds_service_id: "102",
              level: 4,
            },
          ],
          settings_snapshot: {
            ...settings,
            hints_level: hintsLevel,
            parallel_cards: 3,
            ...(phoneContacts ? { phone_contacts: phoneContacts } : {}),
          },
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      session = await created.json();
      let order = 0;
      const assign = async (delay = 0) => {
        order++;
        const response = await request.post(
          `/api/sessions/${session!.id}/assignments`,
          {
            headers,
            data: {
              participant_id: user.id,
              scenario_id: scenario.id,
              order,
              planned_at: new Date(Date.now() + delay).toISOString(),
            },
          },
        );
        expect(response.status()).toBe(201);
      };
      const waitCard = async (count = 1) => {
        let cards: Card[] = [];
        await expect
          .poll(
            async () => {
              cards = (
                (await (await request.get("/api/cards")).json()) as Card[]
              ).filter((c) => c.session_id === session!.id);
              return cards.length;
            },
            { timeout: 30_000 },
          )
          .toBe(count);
        return cards
          .sort((a, b) => a.appeared_at.localeCompare(b.appeared_at))
          .at(-1)!;
      };
      await assign();
      if (secondCard) await assign(15_000);
      expect(
        (
          await request.post(`/api/sessions/${session!.id}/start`, { headers })
        ).ok(),
      ).toBeTruthy();
      // Окно «Параллельная работа» этого занятия считаем прочитанным: проверки
      // фикстуры о другом, а окно само сдвигает фокус (ParallelNotice).
      await page.addInitScript((id) => {
        try {
          localStorage.setItem(`arm:parallel-ack:${id}`, "1");
        } catch {
          // Без хранилища окно закроет обработчик page ниже.
        }
      }, session!.id);
      await use({
        session: session!,
        card: await waitCard(),
        issue: () => waitCard(2),
        finish,
      });
    } finally {
      await finish();
      expect(
        (
          await request.post(`/api/scenarios/${scenario.id}/retire`, {
            headers,
          })
        ).ok(),
      ).toBeTruthy();
    }
  },
});
