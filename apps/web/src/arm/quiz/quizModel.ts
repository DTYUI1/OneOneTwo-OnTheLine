// «Проверьте себя» (29.09): короткий тест по памятке ДДС перед тренировкой — теория,
// которую потом отрабатывают на карточке. Вопросы и ответы — только из памятки
// «Работа с АРМ-112 для ДДС» (docs/dataset), у каждого — страница.

export interface Question {
  id: string;
  text: string;
  options: string[];
  /** Номер верного варианта в options. */
  answer: number;
  explain: string;
  source: string;
}

export const QUESTIONS: readonly Question[] = [
  {
    id: "primary-time",
    text: "За какое время после направления карточки нужно поставить «Принята» или «Не принята»?",
    options: ["30 секунд", "1 минута", "3 минуты", "Когда бригада прибудет"],
    answer: 0,
    explain:
      "Первичный статус проставляется в течение 30 секунд после направления карточки в службу.",
    source: "Памятка ДДС, стр. 21",
  },
  {
    id: "not-notified",
    text: "Что будет, если первичный статус не поставить вовремя?",
    options: [
      "Карточка перейдёт в статус «Не оповещено»",
      "Карточка закроется сама",
      "Карточку заберёт другая служба",
      "Ничего не изменится",
    ],
    answer: 0,
    explain:
      "Отсутствие статуса реагирования переводит карточку в статус «Не оповещено».",
    source: "Памятка ДДС, стр. 21",
  },
  {
    id: "rejected-when",
    text: "Когда ставится статус «Не принята»?",
    options: [
      "Происшествие не в зоне ответственности службы или по нему уже работают по другой карточке",
      "Нет свободных бригад",
      "Заявитель не отвечает на звонок",
      "Работы на месте закончены",
    ],
    answer: 0,
    explain:
      "Место, объект или тип происшествия не входят в зону ответственности службы, либо реагирование уже идёт по другой карточке.",
    source: "Памятка ДДС, стр. 21",
  },
  {
    id: "reason-required",
    text: "Что обязательно при статусах «Не принята» и «Отказ от выполнения работ»?",
    options: [
      "Комментарий с причиной отказа и данными о передаче информации в другие службы",
      "Только номер наряда",
      "Звонок заявителю",
      "Ничего, достаточно статуса",
    ],
    answer: 0,
    explain:
      "Обязателен комментарий: причина отказа от реагирования и данные о передаче информации в другие службы, если она была.",
    source: "Памятка ДДС, стр. 21–22",
  },
  {
    id: "closing-comment",
    text: "Почему все сведения нужно внести в комментарий до статуса «Работы завершены»?",
    options: [
      "Сохранение статуса закрывает карточку для редактирования",
      "Иначе статус не сохранится",
      "Так быстрее для оценки",
      "Комментарий после статуса не виден службам",
    ],
    answer: 0,
    explain:
      "Результаты реагирования отражаются в комментарии до сохранения: статус закрывает карточку для редактирования.",
    source: "Памятка ДДС, стр. 22",
  },
  {
    id: "after-rejected",
    text: "Какой статус можно выбрать после «Не принята»?",
    options: [
      "Только «Принята»",
      "Любой этап реагирования",
      "Только «Работы завершены»",
      "Никакой: карточка закрыта",
    ],
    answer: 0,
    explain:
      "После «Не принята» единственный доступный статус — «Принята», если решено реагировать.",
    source: "Памятка ДДС, стр. 21, 25",
  },
  {
    id: "responding-when",
    text: "Когда ставится статус «Начало реагирования»?",
    options: [
      "Когда получена информация о выезде сил и средств",
      "Сразу вместе с «Принята»",
      "Когда бригада прибыла на место",
      "Когда карточка открыта",
    ],
    answer: 0,
    explain:
      "«Начало реагирования» — выезд сил и средств. Ставится по факту получения информации о выезде.",
    source: "Памятка ДДС, стр. 22",
  },
];

export interface QuizItem extends Question {
  /** Варианты в перемешанном порядке и новый номер верного. */
  shown: string[];
  correct: number;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** count вопросов с перемешанными вариантами: сначала прошлые ошибки (missedIds),
 * потом случайные. Верный вариант не всегда первый. */
export function pickQuiz(
  count = 5,
  random: () => number = Math.random,
  missedIds: readonly string[] = [],
): QuizItem[] {
  const missed = QUESTIONS.filter((question) =>
    missedIds.includes(question.id),
  );
  const rest = QUESTIONS.filter((question) => !missedIds.includes(question.id));
  return [...missed, ...shuffled(rest, random)]
    .slice(0, count)
    .map((question) => {
      const order = shuffled(
        question.options.map((_, index) => index),
        random,
      );
      return {
        ...question,
        shown: order.map((index) => question.options[index]),
        correct: order.indexOf(question.answer),
      };
    });
}

export function quizScore(
  items: readonly QuizItem[],
  answers: readonly (number | null)[],
): number {
  return items.filter((item, index) => answers[index] === item.correct).length;
}

/** Ошибки после проверки: верно отвеченные уходят, неверные добавляются. */
export function updateMissed(
  missedIds: readonly string[],
  items: readonly QuizItem[],
  answers: readonly (number | null)[],
): string[] {
  const right = new Set(
    items
      .filter((item, index) => answers[index] === item.correct)
      .map((item) => item.id),
  );
  const wrong = items
    .filter((item, index) => answers[index] !== item.correct)
    .map((item) => item.id);
  return [
    ...missedIds.filter((id) => !right.has(id) && !wrong.includes(id)),
    ...wrong,
  ];
}

/** Подпись под неактивной «Проверить»: сколько вопросов без ответа. */
export function remainingLabel(
  answers: readonly (number | null)[],
  total: number,
): string {
  const answered = answers.filter((value) => value !== null).length;
  return `осталось ${Math.max(0, total - answered)}`;
}

// Ошибки теста живут только в браузере обучаемого: результат теста нигде не хранится.
const MISSED_KEY = "arm112.quiz.missed";

export function loadMissed(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MISSED_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveMissed(missedIds: readonly string[]): void {
  try {
    if (missedIds.length > 0)
      localStorage.setItem(MISSED_KEY, JSON.stringify(missedIds));
    else localStorage.removeItem(MISSED_KEY);
  } catch {
    // Без хранилища тест работает, просто без повтора ошибок.
  }
}
