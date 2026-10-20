// Один голос тренажёра (макет B): открытая карточка сообщает сюда, что ей нужно сказать —
// шаг проводника, проверку перед необратимым статусом, «Услышано по телефону», — а
// подсказка у элемента (TrainerCoach.tsx) показывает это в обучении. Карточка остаётся
// владельцем действий (её события и форма статуса), как телефон ДДС у окна ArmPage.
//
// Хранилище внешнее (useSyncExternalStore): карточка пишет в него после каждого рендера,
// зона перерисовывается, только когда изменились данные. Обработчики нажатий хранятся
// отдельно и обновляются молча — их читают в момент нажатия.
import { useSyncExternalStore } from "react";
import type { DispatcherStatus } from "../cardModel";
import type { PointerTip } from "../practice/pointer";
import type { ClarityHint } from "./clarity";
import type { CheckedStatus } from "./stages";

/** Проверка перед «Не принята», «Отказ», «Работы завершены» — памятка ДДС, с. 21–22. */
export interface StatusCheck {
  readonly status: CheckedStatus;
  readonly label: string;
  readonly comment: string;
  /** Без комментария статус не сохранить («Не принята», «Отказ»). */
  readonly required: boolean;
}

/** Что открытая карточка сообщает тренажёру. Только данные: сравниваются по значению. */
export interface CardVoice {
  readonly cardId: string;
  readonly sessionId: string;
  readonly number: string;
  /** Личная тренировка обучаемого. */
  readonly practice: boolean;
  /** Шаг проводника (tutorProgress.current); null — упражнение пройдено. */
  readonly step: string | null;
  /** Поставлено «Не принята» — в упражнении карточку нужно принять. */
  readonly rejected: boolean;
  /** Строка статуса открыта (карандаш или Alt+Z); закрыта — шаг статуса с карандаша. */
  readonly lineOpen: boolean;
  /** Шаг проводника и фраза к нему; есть только в обучении («Смотрю», «Вместе»). */
  readonly tip: PointerTip | null;
  /** Карточка закрыта (или проводник считает упражнение пройденным). */
  readonly closed: boolean;
  /** Действовать по карточке можно. */
  readonly canAct: boolean;
  readonly check: StatusCheck | null;
  /** Сколько раз обучаемому помогали: подсказка проводника и «Покажи». */
  readonly helps: number;
  /** Для показа: решение, повод и адрес — из чего тренажёр пишет комментарий. */
  readonly summary: string;
  /**
   * «Услышано по телефону» (TC-05): статус, который старший бригады назвал словами в последнем
   * докладе, и его подпись; null — не называл, уже выбран или его сейчас не поставить.
   */
  readonly heard: {
    readonly status: DispatcherStatus;
    readonly label: string;
  } | null;
  /**
   * Понятность комментария (TC-08): «Возможно, вы имели в виду: …» для «ghbyznf» и «отпр бр»,
   * для «ок» — что написать вместо него. Ничего не блокирует; null — всё понятно.
   */
  readonly clarity: ClarityHint | null;
}

export interface CardHandlers {
  confirmCheck?: () => void;
  backToComment?: () => void;
  /** Записать помощь в журнал карточки (`hint_open`). */
  helped?: (hintId: string) => void;
  review?: () => void;
  /** Разметка карточки: где искать цель подсказки и показа. */
  cardElement?: () => HTMLElement | null;
  /** «Подставить»: выбрать статус в строке статуса; сохраняет его обучаемый сам. */
  applyHeard?: (status: DispatcherStatus) => void;
  /** «Подставить»: исправленный комментарий вместо набранного; отправляет обучаемый сам. */
  applyClarity?: (comment: string) => void;
}

/** Показ тренажёра: «Смотрю» или «Как сделал бы опытный». */
export interface DemoState {
  readonly cardId: string;
  readonly expert: boolean;
  readonly text: string;
  readonly paused: boolean;
  /** Показ сбился или окончен — кнопок управления нет. */
  readonly over: boolean;
}

interface State {
  readonly card: CardVoice | null;
  readonly demo: DemoState | null;
  /** Короткая строка подсказки (щелчок во время показа). */
  readonly note: string | null;
  /** Элемент, у которого сейчас курсор показа: к нему встаёт подсказка «Смотрю». */
  readonly anchor: Element | null;
}

let state: State = { card: null, demo: null, note: null, anchor: null };
let handlers: CardHandlers = {};
// Пауза/остановка отменяет уже начатые async-проверки, но не ручные действия.
let demoGeneration = 0;
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export const trainerStore = {
  get: () => state,
  handlers: () => handlers,
  /** Карточка сообщает свой голос; null — карточка закрыта или ушла с экрана. */
  setCard(card: CardVoice | null, next: CardHandlers = {}) {
    handlers = next;
    if (!same(state.card, card)) emit({ ...state, card });
  },
  /** Карточка ушла с экрана: стираем голос, только если он её. */
  clearCard(cardId: string) {
    if (state.card?.cardId !== cardId) return;
    handlers = {};
    emit({ ...state, card: null });
  },
  setDemo(demo: DemoState | null) {
    if (
      state.demo?.cardId !== demo?.cardId ||
      state.demo?.expert !== demo?.expert ||
      state.demo?.paused !== demo?.paused ||
      state.demo?.over !== demo?.over
    )
      demoGeneration += 1;
    if (!same(state.demo, demo)) emit({ ...state, demo });
  },
  /** Снимок поколения до первого await; null — действие обучаемого, не показа. */
  demoActionGuard(cardId: string): (() => boolean) | null {
    if (state.demo?.cardId !== cardId || state.demo.over) return null;
    const generation = demoGeneration;
    return () => generation === demoGeneration && !state.demo?.paused;
  },
  updateDemo(patch: Partial<DemoState>) {
    if (state.demo) trainerStore.setDemo({ ...state.demo, ...patch });
  },
  setNote(note: string | null) {
    if (state.note !== note) emit({ ...state, note });
  },
  /** Курсор показа перешёл к элементу; null — показа нет. */
  setAnchor(anchor: Element | null) {
    if (state.anchor !== anchor) emit({ ...state, anchor });
  },
  subscribe,
};

export function useTrainerState(): State {
  return useSyncExternalStore(subscribe, trainerStore.get, trainerStore.get);
}
