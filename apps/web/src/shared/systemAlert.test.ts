import { describe, expect, it } from "vitest";
import type { components } from "../api-client/schema";
import { describeOutage } from "./systemAlert";

type Health = components["schemas"]["Health"];

const ok: Health = {
  status: "ok",
  mode: "database",
  database: "ok",
  worker: "ok",
  ai_provider: "off",
};

describe("оповещение о сбое", () => {
  it("всё работает — оповещения нет", () => {
    expect(describeOutage(ok, false)).toEqual([]);
  });

  it("сервер не ответил — это сбой", () => {
    expect(describeOutage(null, true)).toHaveLength(1);
    expect(describeOutage(null, true)[0]).toMatch(/Сервер не отвечает/);
  });

  it("пока ответа не было, тревоги нет", () => {
    expect(describeOutage(null, false)).toEqual([]);
  });

  it("называет, что именно сломалось и что это значит для занятия", () => {
    const problems = describeOutage(
      { ...ok, status: "degraded", database: "error", worker: "error" },
      false,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/База данных/);
    expect(problems[1]).toMatch(/карточки не выдаются/);
  });

  it("при живых БД и worker деградация — это потеря мгновенных обновлений", () => {
    expect(describeOutage({ ...ok, status: "degraded" }, false)[0]).toMatch(
      /Мгновенные обновления/,
    );
  });

  it("mock-режим разработки не считается сбоем", () => {
    expect(
      describeOutage(
        {
          ...ok,
          status: "degraded",
          mode: "mock",
          database: "not_connected",
          worker: "stub",
        },
        false,
      ),
    ).toEqual([]);
  });
});
