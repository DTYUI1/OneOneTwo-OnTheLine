// Этапы обучения (DT-18, макет B): «Смотрю → Вместе → Сам», условности перед
// первым звонком и знак сжатия времени. Тексты — из prototype-b (`STAGES`, `CONVENTIONS`
// в app.js и data.js); «расчёт» прототипа в приложении — «бригада» (глоссарий
// CONTRIBUTING.md), «карточка Громовой» — карточка обучающего упражнения.
//
// Этапы привязаны к тренировке, а не к своей системе: «Смотрю» и «Вместе» — обучающее
// упражнение (ступень 1 «Моего пути», в нём работает проводник), «Сам» — обычная
// тренировка текущей ступени. Режим запоминается по занятию тренировки в браузере,
// как пройденные этапы в макете: сервер о показе не знает.
import memoCheck from "./memoCheck.json";

export type Stage = "watch" | "together" | "solo";
/** Режим карточки: этап или показ опытного после «Сам». */
export type CardMode = Stage | "expert";

export const STAGE_ORDER: readonly Stage[] = ["watch", "together", "solo"];

/**
 * Обучение или тест (решение 17.10): подсказки тренажёра живут, только пока курсант учится
 * с нуля, — «Смотрю», «Вместе» и показ опытного. «Сам», ступени 2–4, каталог сценариев и
 * занятия преподавателя (режима у них нет — null) — тесты, на них чистый АРМ.
 */
export function isLearning(mode: CardMode | null): boolean {
  return mode === "watch" || mode === "together" || mode === "expert";
}

export interface StageInfo {
  readonly n: number;
  readonly title: string;
  readonly what: string;
}

export const STAGES: Record<Stage, StageInfo> = {
  watch: {
    n: 1,
    title: "Смотрю",
    what: "Тренажёр сам проходит карточку тренировки и говорит, что делает. Управление можно взять в любой момент.",
  },
  together: {
    n: 2,
    title: "Вместе",
    what: "Та же карточка, нажимаете вы. Мир ждёт, пока вы не закончите действие. «Покажи» — курсор покажет, куда нажать.",
  },
  solo: {
    n: 3,
    title: "Сам",
    what: "Та же учебная карточка без подсказок — как на занятии: тренажёр молчит.",
  },
};

/**
 * Во сколько раз бригада едет и работает быстрее, чем в жизни. В жизни прибытие — около
 * 10 минут (норматив прибытия пожарных в городе, 123-ФЗ, ст. 76). В приложении от
 * «Начала реагирования» до доклада о прибытии: в тренировке 4–6 с (`TUTORIAL_AFTER_S`
 * в apps/api/app/seed/training.py, `AFTER_S` в app/seed/practice.py) — около 100 раз;
 * в параллельной смене занятия 60 с (`PARALLEL_AFTER_S`) — около 10 раз.
 */
export function timeScale(practice: boolean): number {
  return practice ? 100 : 10;
}

/** Знак сжатия времени — постоянная строка зоны 3 (`coachView` макета). */
export function timeLine(practice: boolean, together: boolean): string {
  // Серверной паузы сценария нет: время карточки идёт и во «Вместе». Правда здесь
  // только та, что бригада упражнения докладывает после статуса и не торопит.
  if (together)
    return "Мир ждёт вас: пока вы не закончили действие, бригада не торопит.";
  return `Бригада едет и работает примерно в ${timeScale(practice)} раз быстрее, чем в жизни. Часы АРМ идут как обычно.`;
}

export interface Convention {
  readonly head: string;
  readonly text: string;
}

/** «Что здесь условно» — четыре строки перед первым звонком (HSEEP, макет B). */
export function conventions(reactionS: number): Convention[] {
  return [
    {
      head: "Связь службы упрощена.",
      text: "Звонки бригады, табло сил и справочник — условность тренажёра. В жизни это рация, телефон и своя система службы, в АРМ-112 их нет.",
    },
    {
      head: "Время сжато.",
      text: `Бригада едет и работает примерно в ${timeScale(true)} раз быстрее, чем в жизни. Часы АРМ идут как обычно, на «Принята» — ${reactionS} секунд.`,
    },
    {
      head: "Служба 101 — допущение.",
      text: "В Москве пожарная охрана работает в своей системе (КИС УСС). Здесь она работает в АРМ-112 — так выбрано для обучения.",
    },
    {
      head: "Скрытых вопросов с подвохом нет.",
      text: "Люди ошибаются так, как ошибаются в жизни. Всё, что нужно, есть в карточке и в словах бригады.",
    },
  ];
}

/**
 * Проверка перед необратимым статусом — памятка ДДС, с. 21–22 (`MEMO_CHECK` макета).
 * Цитаты дословные и длинные, поэтому лежат данными (memoCheck.json), а не строками UI.
 */
export const MEMO_CHECK: Record<
  "rejected" | "refused" | "completed",
  { page: number; text: string }
> = memoCheck;

export type CheckedStatus = keyof typeof MEMO_CHECK;

/** Статус требует проверки перед сохранением. */
export function needsCheck(status: string): status is CheckedStatus {
  return status in MEMO_CHECK;
}

// ---------------------------------------------------------------- хранение в браузере
// Как в макете: пройденные этапы и режимы — в браузере. Хранилище может быть
// недоступно (приватное окно) — тогда этапы живут, пока открыта страница.
// Окно обучения, пройденные этапы и последний этап — свои у каждого пользователя: на общем
// компьютере они переходили к следующему обучаемому (проверка 20.10). Прежние общие ключи
// без пользователя не читаются — чьи они, уже не узнать.

const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
}

const INTRO_KEY = "trainer:intro";
const DONE_KEY = "trainer:done";
const LAST_KEY = "trainer:last";
const own = (key: string, userId: string) => `${key}:${userId}`;
const modeKey = (sessionId: string) => `trainer:mode:${sessionId}`;
const stageKey = (sessionId: string) => `trainer:stage:${sessionId}`;
const expertKey = (cardId: string) => `trainer:expert:${cardId}`;
const sourceKey = (sessionId: string) => `trainer:expert-source:${sessionId}`;

/** Окно «Как устроено обучение» этот пользователь уже видел. */
export function introSeen(userId: string): boolean {
  return read(own(INTRO_KEY, userId)) === "1";
}

export function markIntroSeen(userId: string) {
  write(own(INTRO_KEY, userId), "1");
}

/** Пройденные этапы — для отметки ✓ на кнопках этапов и выбора «Продолжить». */
export function doneStages(userId: string): Set<Stage> {
  const raw = read(own(DONE_KEY, userId)) ?? "";
  return new Set(
    raw.split(",").filter((item): item is Stage => item in STAGES),
  );
}

export function markStageDone(userId: string, stage: Stage) {
  const done = doneStages(userId);
  done.add(stage);
  write(own(DONE_KEY, userId), [...done].join(","));
}

/** Этап, выбранный последним: он отмечен в зоне, пока карточки нет. */
export function lastStage(userId: string): Stage | null {
  const value = read(own(LAST_KEY, userId));
  return value && value in STAGES ? (value as Stage) : null;
}

export function setLastStage(userId: string, stage: Stage) {
  write(own(LAST_KEY, userId), stage);
}

/**
 * Зачтётся ли ступень 1 за тренировку с наставником (окно у портрета, «Этап пройден»; капитан,
 * 20.10). Все три этапа — учебная карточка ступени 1; «Смотрю» — показ, не попытка (HQ-034).
 * `pathStep` — текущая ступень «Моего пути»; до второй её нет.
 */
export function stepOneNote(pathStep: number | undefined): string {
  return pathStep && pathStep >= 2
    ? "Ступень 1 у вас уже зачтена: тренировка с наставником — повторение."
    : "Ступень 1 «Интерфейс и статусы» зачтётся, когда карточка во «Вместе» или «Сам» получит «Зачтено». «Смотрю» — показ, он не засчитывается.";
}

/** Следующий этап по пройденным: первый непройденный, иначе «Сам». */
export function nextStage(done: ReadonlySet<Stage>): Stage {
  return STAGE_ORDER.find((stage) => !done.has(stage)) ?? "solo";
}

/** Режим занятия тренировки; без записи — обычная тренировка («Сам»). */
export function sessionMode(sessionId: string): CardMode {
  const value = read(modeKey(sessionId));
  return value === "watch" ||
    value === "together" ||
    value === "solo" ||
    value === "expert"
    ? value
    : "solo";
}

export function setSessionMode(sessionId: string, mode: CardMode) {
  write(modeKey(sessionId), mode);
}

/** Неопределённый исход перехвата переживает уход из АРМ и перезагрузку страницы. */
export function takeOverUnconfirmed(sessionId: string): boolean {
  return read(`trainer:take-over:${sessionId}`) !== null;
}

/** Владелец маркера — запрос, а не экземпляр провайдера; повтор получает новый токен. */
export function beginTakeOver(sessionId: string): string {
  const owner = crypto.randomUUID();
  write(`trainer:take-over:${sessionId}`, owner);
  return owner;
}

/** Поздний ответ прежнего запроса не вправе снять неопределённость новой попытки. */
export function finishTakeOver(sessionId: string, owner: string): boolean {
  const key = `trainer:take-over:${sessionId}`;
  if (read(key) !== owner) return false;
  write(key, null);
  return true;
}

/**
 * Тренировку запустил этап обучения (выбор у портрета, группа этапов, «Этап пройден»). «Сам»
 * у неё — этап: закрытая карточка ставит ✓ «Сам» (ревью 20.10). У обычной «Тренировки» режим
 * тоже «Сам», но это ступень пути, а не этап.
 */
export function setSessionStage(sessionId: string, stage: Stage) {
  write(stageKey(sessionId), stage);
}

export function sessionStage(sessionId: string): Stage | null {
  const value = read(stageKey(sessionId));
  return value && value in STAGES ? (value as Stage) : null;
}

/** Карточка обучаемого, ради которой запущено занятие показа опытного. */
export function expertSource(sessionId: string): string | null {
  return read(sourceKey(sessionId));
}

export function setExpertSource(sessionId: string, cardId: string) {
  write(sourceKey(sessionId), cardId);
}

/** Карточка опытного, показанная для карточки обучаемого. */
export function expertCardFor(cardId: string): string | null {
  return read(expertKey(cardId));
}

export function linkExpertCard(mine: string, expert: string) {
  write(expertKey(mine), expert);
}
