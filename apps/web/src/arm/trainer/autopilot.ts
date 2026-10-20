// Показ «Смотрю» и «Как сделал бы опытный» (макет B: `autopilot`, `doStep`, из D):
// курсор тренажёра проходит настоящую карточку тренировки через тот же экран, что у
// обучаемого. Шаг берётся у проводника (pointerTip — его публикует карточка в trainerStore),
// нажатия — обычные click, change и input на элементах АРМ и связи службы, поэтому
// действия уходят теми же событиями, что от человека. Своих событий у показа нет.
//
// Серверной паузы нет: «Пауза» останавливает курсор, но не время карточки.
import { findPointer } from "../practice/pointerTarget";
import { demoComment, demoStatus, readMs, SAY, STATUS_SAY } from "./demoModel";
import { ghostPress, ghostTo, hideGhost } from "./ghost";
import { trainerStore, type CardVoice } from "./trainerStore";

const STOP = Symbol("demo-stop");
let run = 0;
// Окна разговора, где показ уже объяснил порядок доклада: по частям — один раз.
const narrated = new WeakSet<Element>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function alive(id: number) {
  if (run !== id || !trainerStore.get().demo) throw STOP;
}

async function gate(id: number) {
  alive(id);
  while (trainerStore.get().demo?.paused) {
    await sleep(150);
    alive(id);
  }
}

async function hold(id: number, ms: number) {
  for (let left = ms; left > 0; left -= 100) {
    await gate(id);
    await sleep(100);
  }
  // Последний интервал тоже мог закончиться уже после паузы/перехвата.
  await gate(id);
}

async function until(
  id: number,
  test: () => boolean,
  ms = 20_000,
): Promise<boolean> {
  const started = performance.now();
  while (!test()) {
    await gate(id);
    if (performance.now() - started > ms) return false;
    await sleep(120);
  }
  return true;
}

const voice = (cardId: string): CardVoice | null => {
  const card = trainerStore.get().card;
  return card?.cardId === cardId ? card : null;
};

const shown = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.getClientRects().length > 0;

/**
 * Курсор — к элементу, подсказка «Смотрю» — рядом с ним (TrainerCoach.tsx). Кнопки самой
 * подсказки (проверка перед статусом) якорем не становятся: подсказка не ходит за собой.
 */
function aim(el: Element) {
  ghostTo(el);
  if (!el.closest("[data-coach]")) trainerStore.setAnchor(el);
}

// Телефон ДДС (GP-09) — окно ArmPage; разговор открытой карточки выводит в него Softphone.
const phone = () => document.querySelector('[data-help="card-phone"]');

/**
 * «Номер наряда» — прямой номер направленной бригады: оценка сверяет его с бригадами
 * карточки (HQ-062, evalcore `service_number_problem`). Показ вписывает номер той бригады,
 * которой звонил (`data-ext` строки контактов), а не «1»; до звонка номера ещё нет — поле
 * ждёт следующего статуса. После перезагрузки страницы — бригада «направлена сюда».
 */
const dispatched = new Map<string, string>();

function brigadeNumber(cardId: string): string | null {
  return (
    dispatched.get(cardId) ??
    phone()?.querySelector<HTMLElement>('button[data-state="here"]')?.dataset
      .ext ??
    null
  );
}

/** Кнопка по имени: aria-label, иначе текст («Положить трубку» — значок без текста). */
function buttonByText(
  root: ParentNode | null,
  text: string,
): HTMLButtonElement | null {
  for (const button of root?.querySelectorAll<HTMLButtonElement>("button") ??
    [])
    if (
      !button.disabled &&
      (button.getAttribute("aria-label") ?? button.textContent?.trim()) === text
    )
      return button;
  return null;
}

const enabled = (root: Element | null, selector: string) => [
  ...(root?.querySelectorAll<HTMLButtonElement>(`${selector}:not(:disabled)`) ??
    []),
];

/** Линия связи открытой карточки: состояние разговора и кнопки ряда ответа. */
function line() {
  const root = phone();
  const head = root?.querySelector<HTMLElement>("[data-call-state]") ?? null;
  return {
    state: head?.dataset.callState ?? null,
    hangup: head ? buttonByText(root, "Положить трубку") : null,
    // Доклад службе по частям (GP-06): варианты текущего шага.
    variants: enabled(root, 'button[data-part="report"]'),
    openVariants: enabled(root, 'button[data-parts="report"]')[0] ?? null,
    // Вводная бригаде по частям (GP-05): кнопка раскрытия и варианты текущего шага.
    openParts: enabled(root, 'button[data-parts="reply"]')[0] ?? null,
    parts: enabled(root, 'button[data-reply="brief"]'),
    ack: enabled(root, 'button[data-reply="ack"]')[0] ?? null,
  };
}

/** Окно телефона закрыто или свёрнуто — показ открывает его значком на панели. */
async function openPhone(id: number) {
  const body = phone()?.querySelector('[aria-label="Контакты"], ol');
  if (shown(body ?? null)) return;
  const dial = document.querySelector<HTMLElement>(
    'button[aria-label^="Телефон"]',
  );
  if (dial) await press(id, dial);
}

async function say(id: number, text: string, el?: Element | null) {
  await gate(id);
  trainerStore.updateDemo({ text });
  if (shown(el ?? null)) {
    aim(el as Element);
    await sleep(650);
  }
  await hold(id, readMs(text));
}

async function press(id: number, el: HTMLElement) {
  aim(el);
  await sleep(650);
  await gate(id);
  ghostPress(true);
  await sleep(200);
  // Пауза/перехват могли прийти во время анимации нажатия.
  await gate(id);
  ghostPress(false);
  el.click();
  await sleep(300);
}

async function act(id: number, text: string, el: HTMLElement | null) {
  if (!shown(el)) throw new Error(`Показ: не найдено «${text}»`);
  await gate(id);
  trainerStore.updateDemo({ text });
  aim(el);
  await hold(id, Math.max(600, readMs(text) - 650));
  await press(id, el);
}

/** Значение в поле React: родной сеттер и событие, как при вводе. */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

async function typeInto(id: number, el: HTMLInputElement, text: string) {
  aim(el);
  await sleep(400);
  el.focus({ preventScroll: true });
  for (let i = 1; i <= text.length; i += 2) {
    await gate(id);
    setValue(el, text.slice(0, i + 1));
    await sleep(25);
  }
  await sleep(250);
}

/** Последний доклад бригады — «Доклады бригад» или лента разговора; основа комментария. */
function lastReport(): string | null {
  const items = phone()?.querySelectorAll(
    'section[aria-label="Доклады бригад"] li, li[data-report] [data-line-text]',
  );
  const text = items?.[items.length - 1]?.textContent?.trim();
  return text || null;
}

async function doStatus(id: number, card: CardVoice, cardEl: HTMLElement) {
  const status = demoStatus(card.step, card.rejected);
  if (!status) throw new Error(`Показ: нет статуса для шага ${card.step}`);
  // Строка статуса закрыта, как в АРМ (DT-17): открыть её карандашом своей плитки.
  if (!cardEl.querySelector('[data-help="card-action"] select')) {
    const pencil = cardEl.querySelector<HTMLElement>(
      'button[aria-label="Изменить статус"]',
    );
    await act(
      id,
      card.step === "decide" ? SAY.pencilFirst : SAY.pencil,
      pencil,
    );
    await until(
      id,
      () => !!cardEl.querySelector('[data-help="card-action"] select'),
      5000,
    );
  }
  const form = cardEl.querySelector('[data-help="card-action"]');
  const select = form?.querySelector("select");
  const number = form?.querySelector<HTMLInputElement>(
    'input[aria-label="Номер наряда"]',
  );
  const comment = form?.querySelector<HTMLInputElement>(
    'input[aria-label="Комментарий"]',
  );
  if (!select || !number || !comment)
    throw new Error("Показ: нет строки статуса");
  await say(id, STATUS_SAY[status] ?? "", select);
  setValue(select, status);
  await sleep(500);
  const brigade = brigadeNumber(card.cardId);
  if (!number.value.trim() && brigade) {
    await say(id, SAY.number, number);
    await typeInto(id, number, brigade);
  }
  await say(id, SAY.comment, comment);
  await typeInto(id, comment, demoComment(status, card.summary, lastReport()));
  trainerStore.updateDemo({ text: SAY.enter });
  aim(comment);
  await hold(id, 900);
  comment.focus({ preventScroll: true });
  comment.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  const before = card.step;
  await until(id, () => {
    const now = voice(card.cardId);
    return !now || now.check !== null || now.step !== before || now.closed;
  });
}

async function doTalk(id: number, card: CardVoice) {
  const talk = line();
  if (talk.state !== "talking") {
    await sleep(200);
    return;
  }
  if (talk.variants.length) {
    // Доклад по частям (GP-06): показ выбирает верную часть шага; после последней
    // вариантов нет — служба отвечает «информация принята», потом отбой.
    const right =
      talk.variants.find((button) => button.dataset.correct === "true") ??
      talk.variants[0];
    const before = talk.variants.map((button) => button.textContent).join();
    const talkEl = phone()?.querySelector("[data-call-state]") ?? null;
    if (talkEl && !narrated.has(talkEl)) {
      narrated.add(talkEl);
      await say(id, SAY.report, talkEl);
    }
    await press(id, right);
    await until(
      id,
      () =>
        line()
          .variants.map((button) => button.textContent)
          .join() !== before,
      5000,
    );
    if (line().variants.length) return;
    await hold(id, 2500);
    await act(id, SAY.hangupReport, line().hangup);
    return;
  }
  if (talk.openVariants) {
    await press(id, talk.openVariants);
    await until(id, () => line().variants.length > 0, 5000);
    return;
  }
  if (talk.openParts) {
    await act(id, SAY.brief, talk.openParts);
    await until(id, () => line().parts.length > 0, 5000);
    return;
  }
  if (talk.parts.length) {
    const right =
      talk.parts.find((button) => button.dataset.correct === "true") ??
      talk.parts[0];
    const before = talk.parts[0].textContent;
    await press(id, right);
    await until(id, () => line().parts[0]?.textContent !== before, 5000);
    return;
  }
  if (talk.ack) {
    await act(id, SAY.ack, talk.ack);
    return;
  }
  const target = card.tip?.target ?? null;
  if (target !== "action") {
    await say(id, SAY.listen);
    // Доклад звучит: ждём, пока проводник не скажет, что он получен.
    const heard = await until(
      id,
      () =>
        voice(card.cardId)?.tip?.target === "action" ||
        line().ack !== null ||
        line().state !== "talking",
      30_000,
    );
    if (heard && line().state === "talking" && line().ack) return;
    if (line().state !== "talking") return;
  }
  await act(id, SAY.hangup, line().hangup);
}

async function doStep(id: number, card: CardVoice, cardEl: HTMLElement) {
  const tip = card.tip;
  if (!tip) return;
  const link = phone();
  if (tip.target === "action") return doStatus(id, card, cardEl);
  if (tip.target === "brigades") {
    // Бригаду направляет вводная в разговоре (GP-05): звоним свободной.
    await openPhone(id);
    const call =
      link?.querySelector<HTMLButtonElement>(
        'button[data-state="free"]:not(:disabled)',
      ) ?? null;
    if (call?.dataset.ext) dispatched.set(card.cardId, call.dataset.ext);
    await say(id, SAY.brigades, link?.querySelector("[data-forces]"));
    await act(id, SAY.call, call);
    await until(id, () => line().state === "talking", 8000);
    return;
  }
  if (tip.target === "brigade-call" || tip.target === "answer")
    await openPhone(id);
  const found = findPointer(cardEl, tip);
  const text =
    tip.target === "brigade-call"
      ? SAY.brigadeCall
      : tip.target === "answer"
        ? SAY.answer
        : SAY.hangup;
  await act(id, text, found?.el ?? null);
  await until(id, () => line().state !== null, 8000);
}

/** Карточка показа закрыта и разговоров нет. */
const finished = (card: CardVoice | null) =>
  !!card && card.closed && line().hangup === null;

async function autopilot(id: number, cardId: string, expert: boolean) {
  await say(id, expert ? SAY.expertIntro : SAY.intro);
  let waitSaid = false;
  for (;;) {
    await gate(id);
    const card = voice(cardId);
    const cardEl = trainerStore.handlers().cardElement?.() ?? null;
    if (!card || !cardEl) {
      await sleep(200);
      continue;
    }
    if (finished(card)) break;
    if (card.check) {
      waitSaid = false;
      // Проверка принадлежит карточке: скрытая подсказка не должна останавливать показ.
      await act(
        id,
        SAY.check,
        cardEl.querySelector<HTMLElement>('[data-help="line-confirm"]'),
      );
      await until(id, () => !voice(cardId)?.check);
      continue;
    }
    if (line().hangup) {
      waitSaid = false;
      await doTalk(id, card);
      continue;
    }
    if (!card.tip || card.closed) {
      if (!waitSaid && !card.closed) {
        await say(id, SAY.wait);
        waitSaid = true;
      }
      await sleep(300);
      continue;
    }
    waitSaid = false;
    await doStep(id, card, cardEl);
  }
  await say(id, SAY.done);
}

/** Запустить показ по карточке; onDone — показ дошёл до конца. */
export function startDemo(
  cardId: string,
  expert: boolean,
  onDone: () => void,
  paused = false,
) {
  const id = ++run;
  trainerStore.setAnchor(null);
  trainerStore.setDemo({
    cardId,
    expert,
    text: "",
    paused,
    over: false,
  });
  autopilot(id, cardId, expert)
    .then(() => {
      if (run !== id) return;
      hideGhost();
      trainerStore.updateDemo({ over: true });
      onDone();
    })
    .catch((error: unknown) => {
      if (error === STOP || run !== id) return;
      console.warn(error);
      hideGhost();
      trainerStore.updateDemo({ text: SAY.failed, over: true });
    });
}

/** Остановить показ: «Беру управление», уход с карточки, новый этап. */
export function stopDemo() {
  run += 1;
  hideGhost();
  trainerStore.setAnchor(null);
  trainerStore.setDemo(null);
}
