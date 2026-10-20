import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseServiceIntent } from "./serviceIntent";

interface Example {
  text: string;
  exts: string[];
  called: boolean;
  option: string | null;
  services: string[];
}
const canonical = (name: string) =>
  new URL(
    `../../../../../../packages/evalcore/evalcore/${name}`,
    import.meta.url,
  );
const corpus = JSON.parse(
  readFileSync(canonical("service_language_corpus.json"), "utf8"),
) as {
  version: number;
  cases: Example[];
};

describe("Единый нормативный корпус Python / TypeScript", () => {
  it.each(corpus.cases)("$text / $exts", (row) => {
    const result = parseServiceIntent(row.text, row.exts);
    expect(result.called).toBe(row.called);
    expect(result.option).toBe(row.option);
    expect(result.services).toEqual(row.services);
  });

  it("браузерный словарь побайтно совпадает с каноническим", () => {
    expect(
      readFileSync(new URL("./serviceLanguage.json", import.meta.url)),
    ).toEqual(readFileSync(canonical("service_language.json")));
  });
});
