import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  ARM_GUIDE,
  CARD_GUIDE,
  RESULTS_GUIDE,
  REFERENCE_GUIDE,
} from "../arm/help/topics";
import { TEACHER_GUIDE } from "../teacher/help/topics";
import { ADMIN_GUIDE } from "../admin/help/topics";
import { OPERATOR_GUIDE } from "../operator/help/topics";

const root = join(process.cwd(), "src");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}
const excluded =
  /(?:\.test\.|\/api-client\/|\/arm\/softphone\/|\/shared\/ws\/|\/shared\/(?:api|contracts|timing)\.ts$)/;
const sources = files(root).filter(
  (file) => /\.tsx?$/.test(file) && !excluded.test(file.replaceAll("\\", "/")),
);
// Окно телефона (GP-23): его кнопки есть в объяснении экрана, поэтому их разметка data-help
// и подписи считаются, хотя правила тона к репликам софтфона не применяются.
const softphone = files(root).filter(
  (file) =>
    /\.tsx$/.test(file) &&
    !/\.test\./.test(file) &&
    file.replaceAll("\\", "/").includes("/arm/softphone/") &&
    !/\/stand(?:-live)?\.tsx$/.test(file.replaceAll("\\", "/")),
);
type Text = { file: string; line: number; value: string };
const texts: Text[] = [];
const regions: string[] = [];
const phoneTexts: Text[] = [];
for (const file of [...sources, ...softphone]) {
  const target = softphone.includes(file) ? phoneTexts : texts;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node: ts.Node) {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      /[а-яё]/i.test(node.text)
    ) {
      target.push({
        file: relative(process.cwd(), file).replaceAll("\\", "/"),
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        value: node.text.replace(/\s+/g, " ").trim(),
      });
    }
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "data-help" &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer))
        regions.push(node.initializer.text);
      else {
        // Динамические части раскрываются по конечным наборам разделов.
        const expression = node.initializer.getText(source);
        if (expression === "{`admin-${section}`}")
          regions.push(
            ...[
              "health",
              "settings",
              "modules",
              "users",
              "backups",
              "services",
              "models",
              "audit",
              "reports",
            ].map((key) => `admin-${key}`),
          );
        else if (expression === "{helpKey}")
          // Кнопка «Тренировка» в списке (ArmPage): в других окнах части нет.
          regions.push("tool-practice");
        else if (expression === "{`teacher-${current}`}")
          regions.push(
            ...["handout", "live", "verdicts", "report"].map(
              (key) => `teacher-${key}`,
            ),
          );
        else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression &&
          ts.isConditionalExpression(node.initializer.expression) &&
          ts.isStringLiteral(node.initializer.expression.whenTrue) &&
          ts.isStringLiteral(node.initializer.expression.whenFalse)
        )
          regions.push(
            node.initializer.expression.whenTrue.text,
            node.initializer.expression.whenFalse.text,
          );
        else
          throw new Error(
            `Добавьте проверку динамической части: ${file}: ${expression}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const guides = [
  ARM_GUIDE,
  CARD_GUIDE,
  RESULTS_GUIDE,
  REFERENCE_GUIDE,
  TEACHER_GUIDE,
  ADMIN_GUIDE,
  OPERATOR_GUIDE,
];
const report = (text: Text) => `${text.file}:${text.line}: ${text.value}`;

if (process.env.UPDATE_TEXT_INVENTORY === "1") {
  writeFileSync(
    join(process.cwd(), "../../scripts/ralph/artwox/TEXT_INVENTORY.md"),
    "# Опись русских строк интерфейса\n\nИзвлечены строки, шаблоны и текст разметки TypeScript; комментарии, тесты и зона Brikkerdev исключены.\n\n" +
      texts.map((text) => `- ${report(text)}`).join("\n") +
      "\n",
  );
}

describe("Тексты интерфейса капитана", () => {
  it("обращается на вы и использует вежливые побуждения", () => {
    const informal =
      /(?:^|[^а-яё])(?:ты|тебя|тебе|тобой|тво[а-яё]*|нажми|открой|выбери|введи|позвони|закрой|поставь|проверь|напиши|укажи|отметь|перейди|вернись|выйди|дождись|заполни|сохрани|отправь|кликни)(?=$|[^а-яё])/i;
    expect(
      texts.filter((text) => informal.test(text.value)).map(report),
    ).toEqual([]);
    const capitals = texts.filter((text) =>
      text.value
        .split(/[.!?]\s*/)
        .some((sentence) => /[а-яё].*Вы(?:\s|[,.!?])/u.test(sentence)),
    );
    expect(capitals.map(report)).toEqual([]);
  });
  it("использует короткие предложения в справках и подсказках", () => {
    const help = texts;
    expect(
      help
        .filter((text) =>
          text.value
            .split(/[.!?](?:\s|$)/)
            .some(
              (sentence) => (sentence.match(/[а-яё]+/gi)?.length ?? 0) > 20,
            ),
        )
        .map(report),
    ).toEqual([]);
  });
  for (const guide of guides) {
    it(`${guide.id}: порядок, тексты, русский язык`, () => {
      expect(new Set(guide.order).size).toBe(guide.order.length);
      expect([...guide.order].sort()).toEqual(Object.keys(guide.topics).sort());
      // CSV — буквальное имя кнопки выгрузки, требуемое HELP-01.
      for (const [key, topic] of Object.entries(guide.topics)) {
        // Названия физических клавиш — как в инструкции оператора 112.
        const names =
          key === "operator-shortcuts"
            ? /\b(?:CSV|Alt|Enter|Esc|Ctrl|Shift|Tab|F[1-3]|[A-Z])\b/g
            : key === "card-history"
              ? /\b(?:CSV|Esc)\b/g
              : /CSV/g;
        expect((topic.title + topic.text).replace(names, "")).not.toMatch(
          /[A-Za-z]/,
        );
        for (const row of topic.table?.rows ?? [])
          expect(row.join(" ").replace(names, "")).not.toMatch(/[A-Za-z]/);
      }
    });
  }
  it("не оставляет части без объяснений", () => {
    const keys = new Set(guides.flatMap((guide) => Object.keys(guide.topics)));
    expect(regions.filter((key) => !keys.has(key))).toEqual([]);
    expect([...keys].filter((key) => !regions.includes(key))).toEqual([]);
  });
  it("в справках называет существующие элементы интерфейса", () => {
    const ui = [...texts, ...phoneTexts]
      .filter(
        (text) =>
          !text.file.includes("/help/") && !text.file.endsWith("/Hint.tsx"),
      )
      .map((text) => text.value);
    const names = guides.flatMap((guide) =>
      Object.values(guide.topics).flatMap((topic) =>
        [...topic.text.matchAll(/«([^»]+)»/g)].map((match) => match[1]),
      ),
    );
    // Исключений пока нет: статусы и доступные имена кнопок входят в исходные строки UI.
    expect(
      names.filter((name) => !ui.some((text) => text.includes(name))),
    ).toEqual([]);
  });
  it("тренажёр не отправляет за повтором в список происшествий", () => {
    // Повтор — кнопка «Ещё раз «Вместе»» рядом с «Разбор» в окне «Этап пройден»
    // обучения (DT-18; прежде — полоса проводника над карточкой).
    const tutor = texts.filter((text) =>
      text.file.endsWith("arm/trainer/TrainerDialogs.tsx"),
    );
    expect(tutor.length).toBeGreaterThan(0);
    const all = tutor.map((text) => text.value).join(" ");
    expect(all).not.toContain("кнопкой «Тренировка» в списке");
    expect(all).toContain("Ещё раз");
  });
});
