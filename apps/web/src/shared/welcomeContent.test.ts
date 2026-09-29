import { expect, it } from "vitest";
import type { User } from "./api";
import { welcomeContent, welcomeSeat } from "./welcomeContent";
import { WORKFLOW_STEPS } from "./workflow";

const user = (role: User["role"]): User =>
  ({
    id: crypto.randomUUID(),
    login: role === "trainee" ? "trainee01" : role,
    full_name: "Проверка",
    role,
    workstation_number: role === "trainee" ? 5 : null,
    dds_service_id: role === "trainee" ? "102" : null,
  }) as User;

it("обучаемому — весь порядок работы с карточкой по шагам", () => {
  const content = welcomeContent("trainee");
  expect(content.begin).toBe("Перейти в тренажёр");
  expect(content.phases.flatMap((phase) => phase.steps)).toEqual(
    WORKFLOW_STEPS.map(({ title, action }) =>
      expect.objectContaining({ title, action }),
    ),
  );
  expect(welcomeSeat(user("trainee"))).toEqual([
    ["Рабочее место", "АРМ 5"],
    ["Служба ДДС", "102"],
    ["Логин", "trainee01"],
  ]);
});

it("преподавателю и администратору — свой порядок работы и роль вместо места", () => {
  for (const role of ["teacher", "admin"] as const) {
    const content = welcomeContent(role);
    expect(content.begin).toBe("Начать работу");
    expect(content.phases.length).toBeGreaterThan(1);
    expect(content.phases.every((phase) => phase.steps.length > 0)).toBe(true);
    expect(content.tip).toContain("«?»");
    expect(welcomeSeat(user(role))[0][0]).toBe("Роль");
  }
  expect(welcomeContent("teacher").pathTitle).toBe(
    "Порядок проведения занятия",
  );
  expect(welcomeContent("admin").phases.at(-1)?.steps[0].title).toBe(
    "Сообщения об ошибках",
  );
});
