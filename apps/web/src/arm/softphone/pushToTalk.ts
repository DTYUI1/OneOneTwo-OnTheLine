// Пробел — push-to-talk в окне телефона (TC-04, docs/competitors/touches.md, п. 16 и
// «Клавиши и ввод»): пока пробел зажат — запись, отпустил — ответ закончен. Правила — чистые
// функции без браузера (проверяются тестами), слушатель клавиш — в Softphone.tsx.

/** То, что нужно знать о нажатии: подмножество KeyboardEvent. */
export interface KeyInput {
  /** Физическая клавиша: не зависит от раскладки, в русской она та же. */
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
}

/**
 * Элементы, где пробел принадлежит им: печать текста и выбор в списке. Кнопки, вкладки и
 * ссылки пробел не держат: после щелчка по карточке или табло фокус остаётся на кнопке, и
 * говорить можно было только с фокусом в окне телефона (проверка 17.10). Вне разговора
 * пробел у кнопки работает как обычно — окно его не принимает (`Softphone`, `down`).
 */
const OWN_SPACE =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], ' +
  '[role="textbox"], [role="combobox"], [role="searchbox"], [role="listbox"], [role="option"]';

/** Пробел нужен элементу: поле ввода или список — окно телефона его не перехватывает. */
export function ownsSpace(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element))
    return false;
  return target.closest(OWN_SPACE) !== null;
}

/**
 * Это нажатие «говорить»: пробел (по `code`, раскладка не важна) без модификаторов и
 * повтора при удержании, не в поле ввода и не в списке.
 */
export function isPushToTalk(
  event: KeyInput,
  target: EventTarget | null,
): boolean {
  return (
    event.code === "Space" &&
    !event.repeat &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.isComposing &&
    !event.defaultPrevented &&
    !ownsSpace(target)
  );
}

// --- Говорить чуть раньше конца реплики и зажать заранее (HQ-052) --------------------------
// Полудуплекс (TC-04) смягчён: за секунду до конца реплики собеседника запись уже можно
// начать — остаток реплики доигрывает, микрофон пишет. Нажатие во время реплики не теряется,
// а «взводится»: запись начнётся сама, когда наступит это окно или реплика кончится, если
// пробел всё ещё зажат (кнопка «Говорить» — до повторного щелчка).

/** За сколько до конца реплики собеседника можно начать говорить, мс. */
export const EARLY_TALK_MS = 1000;

/**
 * Сколько ещё звучать собеседнику, мс: самая длинная из звучащих реплик (служба, бригада,
 * лента). `null` — конец хотя бы одной неизвестен: раннего окна нет, только по концу.
 * Пустой список — никто не говорит (0).
 */
export function peerLeftMs(parts: readonly (number | null)[]): number | null {
  let left = 0;
  for (const part of parts) {
    if (part === null) return null;
    left = Math.max(left, part);
  }
  return left;
}

/** Собеседник договорил или вот-вот договорит: запись уже можно начать. */
export function peerAlmostDone(
  speaking: boolean,
  leftMs: number | null,
): boolean {
  return !speaking || (leftMs !== null && leftMs <= EARLY_TALK_MS);
}

/**
 * Что сделать с нажатием «говорить» при свободном микрофоне: `start` — писать сейчас,
 * `arm` — ждать конца реплики (нажатие принято), `ignore` — микрофон занят.
 */
export function pressOutcome(input: {
  readonly idle: boolean;
  readonly speaking: boolean;
  readonly leftMs: number | null;
}): "start" | "arm" | "ignore" {
  if (!input.idle) return "ignore";
  return peerAlmostDone(input.speaking, input.leftMs) ? "start" : "arm";
}

/**
 * Когда снова проверить взведённое нажатие, мс: к началу раннего окна, а пока конец
 * реплики неизвестен (запись грузится) — через `pollMs`.
 */
export function armRecheckMs(leftMs: number | null, pollMs = 200): number {
  if (leftMs === null) return pollMs;
  return Math.min(pollMs, Math.max(20, leftMs - EARLY_TALK_MS));
}

/**
 * Ключ `n`-й реплики ленты (записи банка). Реплика, продолжающая другую, берёт её ключ
 * `continues`: «Как приняли?» после доклада — тот же разговорный ход, что и доклад, и
 * ранний ответ на доклад («Принял») на нём не гаснет — он и есть ответ на «Как приняли?»
 * (HQ-052, TC-01).
 */
export function bankSpeechKey(n: number, continues: string | null): string {
  return continues ?? `bank:${n}`;
}

/**
 * Гасить ли запись, когда собеседник говорит. `peer` — звучащие сейчас реплики (служба,
 * бригада, лента; у каждой свой ключ), `startedOn` — те, что звучали, когда запись начали.
 * Запись, начатая в последнюю секунду реплики (или взведённым нажатием, пока та звучала), —
 * ответ на эту реплику: её остаток запись не гасит. Новая реплика — как и в тишине —
 * гасит (полудуплекс, TC-04): иначе фраза ушла бы ответом на вопрос, заданный уже во время
 * записи (HQ-052).
 */
export function cancelsRecording(input: {
  readonly recording: boolean;
  readonly peer: readonly string[];
  readonly startedOn: readonly string[];
}): boolean {
  return (
    input.recording && input.peer.some((id) => !input.startedOn.includes(id))
  );
}

/**
 * Что сделать, когда отпущен пробел (или окно потеряло фокус), если нажатие было принято:
 * `disarm` — запись ещё ждала конца реплики и не начнётся, `stop` — закончить запись,
 * `stopWhenStarted` — микрофон ещё включается, запись закончится, как только начнётся.
 * `armed` — взведённое нажатие на момент отпускания: его ставят прямо при нажатии, а не
 * после перерисовки, иначе отпускание в том же тике приняли бы за конец записи (HQ-052).
 */
export function releaseOutcome(input: {
  readonly armed: "space" | "button" | null;
  readonly recording: boolean;
}): "disarm" | "stop" | "stopWhenStarted" {
  if (input.armed === "space") return "disarm";
  return input.recording ? "stop" : "stopWhenStarted";
}
