import { describe, expect, it } from "vitest";
import { freeTrainees, traineeByText, traineeLabel } from "./traineeModel";

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
