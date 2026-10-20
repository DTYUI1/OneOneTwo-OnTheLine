import type { components } from "../api-client/schema";
import { latestVersions } from "../teacher/materials/materialsModel";

export type LessonMaterials = components["schemas"]["SessionMaterials"];
export const referenceKey = ["materials-by-session"] as const;
export const lessonFiles = (lesson: LessonMaterials) =>
  latestVersions(lesson.materials);

/** Первую загрузку и начало другого занятия не выдаём за новое назначение файла. */
export function addedReferences(
  before: LessonMaterials[] | undefined,
  after: LessonMaterials[],
) {
  if (!before) return [];
  return after
    .filter((lesson) => lesson.is_current)
    .flatMap((lesson) => {
      const previous = before.find(
        (item) => item.session_id === lesson.session_id && item.is_current,
      );
      if (!previous) return [];
      const known = new Set(
        previous.materials.map((item) => `${item.id}:${item.version}`),
      );
      return lessonFiles(lesson).filter(
        (item) => !known.has(`${item.id}:${item.version}`),
      );
    });
}
