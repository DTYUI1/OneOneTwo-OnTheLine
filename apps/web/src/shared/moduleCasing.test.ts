// Модули одной папки не различаются только регистром (HQ-059): импорт «./phone/CardLine» без
// расширения на Windows и macOS находил cardLine.ts вместо CardLine.tsx — tsc падал, а Vite
// отдал бы окну АРМ не тот модуль. На Linux (облако, Docker-стенд) такой пары не видно.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE = /\.(ts|tsx|js|jsx|mts|cts)$/;

function collisions(dir: string): string[] {
  const found: string[] = [];
  const byName = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules")
        found.push(...collisions(join(dir, entry.name)));
      continue;
    }
    if (!MODULE.test(entry.name)) continue;
    const key = entry.name.replace(MODULE, "").toLowerCase();
    const other = byName.get(key);
    if (other && other !== entry.name)
      found.push(`${join(dir, other)} ↔ ${entry.name}`);
    else byName.set(key, entry.name);
  }
  return found;
}

describe("имена модулей", () => {
  it("в одной папке нет модулей, различающихся только регистром", () => {
    expect(collisions(join(__dirname, ".."))).toEqual([]);
  });
});
