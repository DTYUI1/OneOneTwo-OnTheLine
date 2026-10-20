import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_STEPS } from "./workflow";

// Всё, что проводник берёт в кавычки «…», обучаемый ищет глазами на экране или
// слышит в трубке. Список собран из подписей телефона и карточки; второй тест
// сверяет его с исходниками, чтобы подпись не разошлась с экраном при правке.
const KNOWN_BUTTON_LABELS: readonly string[] = [
  // Карточка: поля, плитки служб, статусы.
  "Пострадавшие",
  "Принята",
  "Не принята",
  "Начало реагирования",
  "Прибытие",
  "Проведение работ",
  "Работы завершены",
  "Отказ от выполнения работ",
  // Шапка АРМ и вкладки происшествий.
  "Порядок работы",
  "Мои результаты",
  "Бригада вызывает",
  // Связь службы: разделы, кнопки и реплики службы.
  "Справочник",
  "Позвонить",
  "Положить трубку",
  "Слушаю вас",
  "Информация принята",
];

function quoted(text: string): string[] {
  return [...text.matchAll(/«([^»]+)»/g)].map((match) => match[1]);
}

const root = join(process.cwd(), "src");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

describe("WORKFLOW_STEPS", () => {
  it("называет только подписи, которые есть на экране", () => {
    const labels = WORKFLOW_STEPS.flatMap((step) => quoted(step.action));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(KNOWN_BUTTON_LABELS).toContain(label);
    expect(labels).not.toContain("Завершить");
  });

  it("каждая известная подпись действительно есть в интерфейсе", () => {
    const screen = files(root)
      .filter(
        (file) =>
          /\.tsx?$/.test(file) &&
          !/\.test\./.test(file) &&
          !/(?:\/api-client\/|\/shared\/workflow\.ts$)/.test(
            file.replaceAll("\\", "/"),
          ),
      )
      .map((file) => readFileSync(file, "utf8").toLowerCase())
      .join("\n");
    for (const label of KNOWN_BUTTON_LABELS)
      expect(screen, label).toContain(label.toLowerCase());
  });

  it("называет каждое поле, которое проверяет оценка заполненности", () => {
    const all = WORKFLOW_STEPS.map((step) => step.action).join(" ");
    expect(all).toContain("номер наряда");
    // Адрес ДДС не вводит (DT-14): уточнённый адрес пишет в комментарий.
    expect(all).toContain("уточнённый адрес");
    expect(all).not.toContain("Адрес — ввод диспетчера");
    expect(all).toContain("комментар");
  });
});
