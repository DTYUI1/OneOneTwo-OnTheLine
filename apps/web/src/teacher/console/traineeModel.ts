import type { User } from "../../shared/api";

/** Как обучаемый показан в поле и в подсказках: «Иванов И. И. (ivanov)». */
export function traineeLabel(user: Pick<User, "full_name" | "login">): string {
  return `${user.full_name} (${user.login})`;
}

/** Выбранная подсказка или точно набранный логин; иначе — никто. */
export function traineeByText<T extends Pick<User, "full_name" | "login">>(
  trainees: readonly T[],
  text: string,
): T | undefined {
  const typed = text.trim().toLowerCase();
  if (!typed) return undefined;
  return (
    trainees.find((user) => traineeLabel(user).toLowerCase() === typed) ??
    trainees.find((user) => user.login.toLowerCase() === typed)
  );
}

/** Подсказки: ещё не выбранные в других строках, по алфавиту ФИО. */
export function freeTrainees<T extends Pick<User, "id" | "full_name">>(
  trainees: readonly T[],
  chosen: readonly string[],
): T[] {
  const used = new Set(chosen);
  return trainees
    .filter((user) => !used.has(user.id))
    .sort((a, b) => a.full_name.localeCompare(b.full_name, "ru"));
}
