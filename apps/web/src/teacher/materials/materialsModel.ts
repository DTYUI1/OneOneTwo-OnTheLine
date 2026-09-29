// Материалы занятия (D-03, C-07): справка для обучаемого и материалы для оценивания.
// Чистая логика без React и сети: подписи, проверка файла до загрузки, выбор справки.
import type { components } from "../../api-client/schema";

export type Material = components["schemas"]["Material"];
export type Purpose = Material["purpose"];

export const PURPOSE_LABELS: Record<Purpose, string> = {
  reference: "справка для обучаемого",
  evaluation: "только для оценивания",
};

/** Типы, которые принимает сервер (materials/service.py: PDF, DOCX, JSON, XML, CSV). */
export const MEDIA_TYPES: Record<string, { label: string; ext: string[] }> = {
  "application/pdf": { label: "Документ для печати", ext: [".pdf"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    label: "Текстовый документ",
    ext: [".docx"],
  },
  "application/json": { label: "Структурированные данные", ext: [".json"] },
  "application/xml": { label: "Разметка данных", ext: [".xml"] },
  "text/csv": { label: "CSV", ext: [".csv"] },
};

export const MAX_BYTES = 10 * 1024 * 1024;

export const ACCEPT = Object.values(MEDIA_TYPES)
  .flatMap((item) => item.ext)
  .join(",");

/** Тип по расширению: браузеры не всегда знают MIME для DOCX/CSV, сервер сверит содержимое. */
export function mediaTypeFor(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const found = Object.entries(MEDIA_TYPES).find(([, item]) =>
    item.ext.some((ext) => lower.endsWith(ext)),
  );
  return found ? found[0] : null;
}

/** Проверка до отправки — те же границы, что у сервера. */
export function fileProblem(
  file: { name: string; size: number } | null,
): string | null {
  if (!file) return "Выберите файл.";
  if (file.size === 0) return "Файл пуст.";
  if (file.size > MAX_BYTES)
    return "Файл больше 10 МиБ — сервер его не примет.";
  if (!mediaTypeFor(file.name))
    return "Тип файла не поддерживается. Выберите документ, таблицу или файл данных из списка в окне выбора файла.";
  return null;
}

/** Размер по-человечески. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/**
 * Каталог: у каждого материала показываем последнюю версию, прежние — счётчиком.
 * Для занятия выбирается только справка (reference): материалы для оценивания
 * обучаемому не выдаются — это правило и сервера, и экрана.
 */
export function latestVersions(
  materials: Material[],
): (Material & { versions: number })[] {
  const byId = new Map<string, Material[]>();
  for (const material of materials)
    byId.set(material.id, [...(byId.get(material.id) ?? []), material]);
  return [...byId.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => b.version - a.version);
      return { ...sorted[0], versions: sorted.length };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function assignable(materials: Material[]): Material[] {
  return latestVersions(materials).filter(
    (material) => material.purpose === "reference",
  );
}

/** Ссылка на содержимое точной версии — тот же адрес обслуживает и ученика. */
export function contentUrl(material: Pick<Material, "id" | "version">): string {
  return `/api/materials/${material.id}/content?version=${material.version}`;
}
