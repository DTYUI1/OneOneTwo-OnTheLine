import { describe, expect, it } from "vitest";
import {
  freeTrainees,
  traineeByText,
  traineeLabel,
  traineeOptions,
} from "./traineeModel";

const people = [
  { id: "3", full_name: "Сидоров С. С.", login: "sidorov" },
  { id: "1", full_name: "Иванов И. И.", login: "ivanov" },
  { id: "2", full_name: "Петров П. П.", login: "petrov" },
];

describe("выбор обучаемого в занятии", () => {
  it("находит по выбранной подсказке и по точному логину", () => {
    expect(traineeByText(people, traineeLabel(people[1]))?.id).toBe("1");
    expect(traineeByText(people, "  PETROV ")?.id).toBe("2");
    expect(traineeByText(people, "Петр")).toBeUndefined();
    expect(traineeByText(people, "")).toBeUndefined();
  });

  it("подсказывает только ещё не выбранных, по алфавиту", () => {
    expect(freeTrainees(people, ["2"]).map((user) => user.login)).toEqual([
      "ivanov",
      "sidorov",
    ]);
  });
});

it("сохраняет ID при повторном выборе полной подписи и отличает совпадающие ФИО", () => {
  const sameNames = [
    { id: "1", full_name: "Иванов Иван", login: "trainee01" },
    { id: "3", full_name: "Иванов Иван", login: "trainee03" },
  ];
  const label = traineeLabel(sameNames[1]);
  expect(traineeByText(sameNames, label)?.id).toBe("3");
  expect(traineeByText(sameNames, label)?.id).toBe("3");
  expect(traineeByText(sameNames, "Иванов Иван")).toBeUndefined();
});

it("подсказки оставляют текущий выбор и исключают участников других строк", () => {
  expect(
    traineeOptions(people, ["1", "2"], "1", "Иванов").map((p) => p.id),
  ).toEqual(["1"]);
  expect(traineeOptions(people, ["1", "2"], "1", "Петров")).toEqual([]);
  expect(traineeOptions(people, [], "", "petrov").map((p) => p.id)).toEqual([
    "2",
  ]);
});

it("находит новых пользователей за пределами первых двадцати подсказок", () => {
  const users = Array.from({ length: 35 }, (_, i) => ({
    id: String(i),
    full_name: `Обучаемый ${String(i).padStart(2, "0")}`,
    login: `student${i}`,
  }));
  expect(traineeOptions(users, [], "", "")).toHaveLength(20);
  expect(
    traineeOptions(users, [], "", "student34").map((user) => user.id),
  ).toEqual(["34"]);
});
