import {
  expect,
  request as api,
  type APIRequestContext,
} from "@playwright/test";
import type { components } from "../../apps/web/src/api-client/schema";

// Отдельные обучаемые на прогон (ревью 20.10): общие trainee01–05 копят попытки других тестов
// и ручных проверок — trainee02 оказался на ступени 2, и проверки ступени 1 падали. Учётку
// заводит администратор, после теста она уходит в корзину.

type User = components["schemas"]["User"];

const PASSWORD = process.env.DEMO_PASSWORD ?? "demo-local";

async function admin(baseURL: string): Promise<APIRequestContext> {
  const context = await api.newContext({ baseURL, ignoreHTTPSErrors: true });
  const login = await context.post("/api/auth/login", {
    data: { login: "admin", password: PASSWORD },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  return context;
}

async function csrf(context: APIRequestContext): Promise<string> {
  return (await context.storageState()).cookies.find(
    (cookie) => cookie.name === "csrf",
  )!.value;
}

export interface Trainee {
  readonly id: string;
  readonly login: string;
  readonly password: string;
}

/** Новый обучаемый службы `service` на ступени 1; логин — `prefix` и метка времени. */
export async function freshTrainee(
  baseURL: string,
  prefix: string,
  service = "101",
): Promise<Trainee> {
  const context = await admin(baseURL);
  const login = `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 2).toString(36)}`;
  const created = await context.post("/api/users", {
    headers: { "X-CSRF-Token": await csrf(context) },
    data: {
      login,
      full_name: `Обучаемый ${prefix}`,
      role: "trainee",
      password: PASSWORD,
      workstation_number: 23,
      dds_service_id: service,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const user: User = await created.json();
  await context.dispose();
  return { id: user.id, login, password: PASSWORD };
}

/** Учётка прогона — в корзину: в списках преподавателя её больше нет. */
export async function dropTrainee(baseURL: string, trainee: Trainee) {
  const context = await admin(baseURL);
  await context.post(`/api/users/${trainee.id}/trash`, {
    headers: { "X-CSRF-Token": await csrf(context) },
  });
  await context.dispose();
}
