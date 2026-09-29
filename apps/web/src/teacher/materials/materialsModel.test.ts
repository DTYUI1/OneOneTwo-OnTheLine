import { describe, expect, it } from "vitest";
import {
  assignable,
  contentUrl,
  fileProblem,
  formatSize,
  latestVersions,
  mediaTypeFor,
  type Material,
} from "./materialsModel";

const m = (
  id: string,
  version: number,
  purpose: Material["purpose"],
  created: string,
) =>
  ({
    id,
    version,
    purpose,
    title: id,
    media_type: "application/pdf",
    size_bytes: 1,
    sha256: "a".repeat(64),
    created_at: created,
  }) as Material;

describe("материалы занятия", () => {
  it("тип по расширению и отказ в неподдержанных", () => {
    expect(mediaTypeFor("Памятка ДДС.PDF")).toBe("application/pdf");
    expect(mediaTypeFor("разбор.docx")).toMatch(/wordprocessingml/);
    expect(fileProblem({ name: "фото.png", size: 10 })).toBe(
      "Тип файла не поддерживается. Выберите документ, таблицу или файл данных из списка в окне выбора файла.",
    );
  });

  it("границы размера — как у сервера", () => {
    expect(fileProblem({ name: "a.pdf", size: 0 })).toBe("Файл пуст.");
    expect(fileProblem({ name: "a.pdf", size: 11 * 1024 * 1024 })).toMatch(
      /10 МиБ/,
    );
    expect(fileProblem({ name: "a.pdf", size: 5 })).toBeNull();
  });

  it("в каталоге — последняя версия, для занятия — только справка", () => {
    const list = [
      m("pam", 1, "reference", "2026-09-25T10:00:00Z"),
      m("pam", 2, "reference", "2026-09-25T11:00:00Z"),
      m("key", 1, "evaluation", "2026-09-25T12:00:00Z"),
    ];
    const latest = latestVersions(list);
    expect(latest.map((x) => [x.id, x.version, x.versions])).toEqual([
      ["key", 1, 1],
      ["pam", 2, 2],
    ]);
    expect(assignable(list).map((x) => x.id)).toEqual(["pam"]);
  });

  it("ссылка на точную версию и размер словами", () => {
    expect(contentUrl({ id: "x", version: 3 })).toBe(
      "/api/materials/x/content?version=3",
    );
    expect(formatSize(2048)).toBe("2 КБ");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 МБ");
  });
});
