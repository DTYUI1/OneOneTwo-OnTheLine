import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compactData, type Questionnaire, type SourceScenario } from "./data";

const repo = join(process.cwd(), "../..");
const read = (path: string): unknown =>
  JSON.parse(readFileSync(join(repo, path), "utf8"));
const scenarioDir = "data/operator/scenarios";
const cardDir = "data/operator/questionnaires";
const readDir = <T>(dir: string): T[] =>
  readdirSync(join(repo, dir))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => read(`${dir}/${name}`) as T);
const expected = compactData(
  read("data/classifier.json") as Parameters<typeof compactData>[0],
  readDir<SourceScenario>(scenarioDir),
  readDir<Questionnaire>(cardDir),
);
const target = join(process.cwd(), "src/operator/data.json");

if (process.env.UPDATE_OPERATOR_DATA === "1")
  writeFileSync(target, JSON.stringify(expected, null, 2) + "\n");

describe("данные оператора 112", () => {
  it("совпадают с data/classifier.json, сценариями и картами", () => {
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(expected);
  });
});
