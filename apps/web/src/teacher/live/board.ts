// Сведение занятия, участников и карточек в плитки live-доски.
// Чистые функции без React и сети — считаются и проверяются тестами.
//
// Время — общим расчётом C-02 (`shared/timing.ts`) через адаптер АРМ
// (`arm/timingAdapter.ts`), по версии методики из снимка занятия: доска,
// карточка обучаемого и оценка должны видеть одно и то же число.
// v3 (contracts/I-TIME.md#v3): реакция — от направления карточки до первого
// «Принята» / «Не принята», открытие её не закрывает; обработка — от первого
// открытия до терминала, а норматив сравнивается с активной обработкой — без
// подтверждённого ожидания сведений. v1/v2 пересчитываются по своим правилам.
//
// Живые таймеры идут здесь, а не приходят с сервера: доска показывает
// обратный отсчёт в реальном времени. Итоговые числа для разбора и отчётов
// даёт `AttemptAnalysis.timing` (C-06) — их мы не пересчитываем; оттуда же
// берётся подтверждённое ожидание, журнала которого у клиента нет.

import type { components } from "../../api-client/schema";
import { cardLiveTiming, type TimingContext } from "../../arm/timingAdapter";

export type Card = components["schemas"]["Card"];
export type Session = components["schemas"]["Session"];
export type Participant = components["schemas"]["Participant"];
export type User = components["schemas"]["User"];
export type Service = components["schemas"]["Service"];
export type StoredEvent = components["schemas"]["StoredEvent"];
export type { TimingContext };

/** Что происходит на рабочем месте — одним словом, без иконок-ребусов. */
export type TilePhase = "offline" | "free" | "reaction" | "handling";

/**
 * Зачем доске три состояния, а не два: сигнал должен позвать, пока успеть
 * ещё можно. Красное после провала — отчёт, а не помощь.
 */
export type TileAlert = "none" | "soon" | "overdue";

/** Последние секунды норматива реакции (`extra_features` 5.3). */
export const WARN_REACTION_S = 5;
/** Та же доля от норматива обработки: 30 с из 180 с. */
export const WARN_HANDLING_S = 30;

export function alertFor(
  phase: "reaction" | "handling",
  remainingS: number,
): TileAlert {
  if (remainingS < 0) return "overdue";
  const threshold = phase === "reaction" ? WARN_REACTION_S : WARN_HANDLING_S;
  return remainingS <= threshold ? "soon" : "none";
}

export interface BoardTile {
  readonly workstationNumber: number;
  readonly userId: string;
  readonly fullName: string;
  /** Название службы, а не её код: «ЖКХ», а не «GKH». */
  readonly ddsServiceName: string;
  readonly level: number;
  readonly online: boolean;
  readonly phase: TilePhase;
  readonly card: Card | null;
  /** Сколько ещё карточек в работе, кроме показанной. */
  readonly alsoOpen: number;
  /** Норматив текущей фазы в секундах; `null` — фазы нет. */
  readonly normativeS: number | null;
  /** Сколько осталось; отрицательное — просрочено на столько же. */
  readonly remainingS: number | null;
  readonly alert: TileAlert;
  /**
   * Версия методики времени: в v3 реакцию закрывает статус, а не открытие —
   * от этого зависит, как назвать фазу. `null` — снимок ещё не загружен.
   */
  readonly version: number | null;
  /** Сколько секунд бригада ждёт ответа обучаемого (любая его карточка); `null` — не ждёт. */
  readonly brigadeWaitS: number | null;
}

/** Карточка закрыта для правок (C-01 v3): таймеров у неё больше нет. */
const CLOSED_STATES = new Set<Card["state"]>([
  "completed",
  "refused",
  "redirected",
]);

/**
 * В работе всё, что не закрыто: «Прибытие» и «Проведение работ» (v3) — тоже
 * работа. Идёт ли по карточке отсчёт, решает расчёт времени, а не список.
 */
export function isActive(card: Card): boolean {
  // Прерванная попытка (занятие завершено, тренировка перезапущена) — уже не работа.
  return (
    card.closed_at === null &&
    card.interrupted_at === null &&
    !CLOSED_STATES.has(card.state)
  );
}

/** Что известно о карточке сверх её полей. */
export interface CardClock {
  /** Журнал карточки; `undefined` — ещё не загружен. */
  readonly events: readonly StoredEvent[] | undefined;
  /** Подтверждённое ожидание сведений из разбора попытки; `null` — неизвестно. */
  readonly waitingS: number | null;
  /** С какого момента бригада звонит и ждёт ответа (самый ранний вызов); `null` — не звонит. */
  readonly callingSince?: string | null;
}

export interface CardTiming {
  readonly phase: "reaction" | "handling";
  readonly normativeS: number;
  /** Сколько осталось; отрицательное — просрочено; `null` — ещё не посчитано. */
  readonly remainingS: number | null;
  readonly version: number | null;
}

/**
 * Фаза и остаток по одной карточке; `null` — отсчёта нет (например, карточка
 * окончательно «Не принята»: в v3 это терминал обработки).
 */
export function cardTiming(
  card: Card,
  clockInput: CardClock,
  context: TimingContext | null,
  now: number,
): CardTiming | null {
  if (!context || !clockInput.events) {
    // Пока нет журнала и снимка — фаза по статусу, без числа: неверный
    // остаток хуже пустого.
    const waitsStatus = card.state === "added" || card.state === "received";
    return {
      phase: waitsStatus ? "reaction" : "handling",
      normativeS: waitsStatus
        ? (context?.legacyReactionS ?? 0)
        : (context?.legacyHandlingS ?? 0),
      remainingS: null,
      version: null,
    };
  }
  if (card.delivered_at === null)
    // Выдана, но на АРМ ещё не появилась (обучаемый не вошёл): реакция по ней
    // начнётся с показа строки, остаток пока не считаем.
    return {
      phase: "reaction",
      normativeS:
        context.policy?.reaction_normative_s ?? context.legacyReactionS,
      remainingS: null,
      version: context.policy?.timing_version ?? 1,
    };
  const live = cardLiveTiming(card, [...clockInput.events], context, now);
  if (live.reaction.running && live.reaction.seconds !== null)
    return {
      phase: "reaction",
      normativeS: live.reaction.normative,
      remainingS: Math.round(live.reaction.normative - live.reaction.seconds),
      version: live.version,
    };
  if (live.handling.running && live.handling.seconds !== null) {
    // v3 сравнивает норматив с активной обработкой. Ожидание неизвестно —
    // показываем полную: так же, как карточка обучаемого, без выдумки.
    const waiting =
      live.version === 3 && clockInput.waitingS !== null
        ? clockInput.waitingS
        : 0;
    const spentS = Math.max(0, live.handling.seconds - waiting);
    return {
      phase: "handling",
      normativeS: live.handling.normative,
      remainingS: Math.round(live.handling.normative - spentS),
      version: live.version,
    };
  }
  return null;
}

/**
 * Показываем ту карточку, по которой времени осталось меньше всего:
 * при параллельных карточках преподавателю важна самая горящая.
 */
export function mostUrgent(
  timed: readonly { card: Card; timing: CardTiming }[],
): { card: Card; timing: CardTiming } | null {
  let best: { card: Card; timing: CardTiming } | null = null;
  let bestRemaining = Number.POSITIVE_INFINITY;
  for (const item of timed) {
    const remaining = item.timing.remainingS ?? Number.POSITIVE_INFINITY;
    if (best === null || remaining < bestRemaining) {
      bestRemaining = remaining;
      best = item;
    }
  }
  return best;
}

export interface BoardInput {
  readonly session: Session | null;
  readonly users: readonly User[];
  readonly cards: readonly Card[];
  readonly services: readonly Service[];
  readonly online: ReadonlySet<string>;
  readonly now: number;
  /** Снимок методики времени занятия; `null` — ещё не загружен. */
  readonly timing: TimingContext | null;
  /** Журналы и ожидание по ID карточки. */
  readonly clocks: ReadonlyMap<string, CardClock>;
}

const UNKNOWN_CLOCK: CardClock = { events: undefined, waitingS: null };

export function buildBoard(input: BoardInput): readonly BoardTile[] {
  const { session, users, cards, services, online, now, timing, clocks } =
    input;
  if (!session) return [];
  const byId = new Map(users.map((user) => [user.id, user]));
  const serviceName = new Map(
    services.map((service) => [service.id, service.name]),
  );
  const active = cards.filter(
    (card) => card.session_id === session.id && isActive(card),
  );

  return [...session.participants]
    .sort((left, right) => left.workstation_number - right.workstation_number)
    .map((participant) => {
      const mine = active
        .filter((card) => card.trainee_id === participant.user_id)
        .flatMap((card) => {
          const cardClock = clocks.get(card.id) ?? UNKNOWN_CLOCK;
          const counted = cardTiming(card, cardClock, timing, now);
          return counted ? [{ card, timing: counted }] : [];
        });
      const shown = mostUrgent(mine);
      // Бригада звонит и ждёт: преподаватель видит, что обучаемый не отвечает.
      const calling = active
        .filter((card) => card.trainee_id === participant.user_id)
        .map((card) => clocks.get(card.id)?.callingSince ?? null)
        .filter((since): since is string => since !== null)
        .map((since) => Date.parse(since));
      const brigadeWaitS = calling.length
        ? Math.max(0, Math.round((now - Math.min(...calling)) / 1000))
        : null;
      const isOnline = online.has(participant.user_id);
      const counted = shown?.timing ?? null;
      return {
        workstationNumber: participant.workstation_number,
        userId: participant.user_id,
        fullName: byId.get(participant.user_id)?.full_name ?? "Обучаемый",
        ddsServiceName:
          serviceName.get(participant.dds_service_id) ??
          participant.dds_service_id,
        level: participant.level,
        online: isOnline,
        phase: !isOnline ? "offline" : (counted?.phase ?? "free"),
        card: shown?.card ?? null,
        alsoOpen: Math.max(0, mine.length - 1),
        normativeS: counted?.normativeS ?? null,
        remainingS: counted?.remainingS ?? null,
        // Место не в сети с горящей карточкой — не повод молчать, а повод
        // позвать: обучаемый отошёл от АРМ, а норматив идёт (Q&A Q11).
        alert:
          counted && counted.remainingS !== null
            ? alertFor(counted.phase, counted.remainingS)
            : "none",
        version: counted?.version ?? null,
        brigadeWaitS,
      } satisfies BoardTile;
    });
}

/** «2:14», «0:07», а для просрочки — величина без знака. */
/**
 * Дольше этого норматив уже ничего не измеряет, а четырёхзначные минуты на
 * плитке выглядят как сломанный счётчик — и это первое, что видит
 * преподаватель. Порог тот же, что на карточке АРМ (`formatDuration`).
 */
export const CLOCK_CAP_S = 5999;

export function clock(totalS: number): string {
  const whole = Math.abs(Math.round(totalS));
  if (whole > CLOCK_CAP_S) return "99:59+";
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Номера АРМ, которые просят внимания, — заголовок называет их прямо,
 * чтобы преподаватель знал, к кому идти, а не пересчитывал плитки.
 */
export function attentionSeats(tiles: readonly BoardTile[]): {
  readonly soon: readonly number[];
  readonly overdue: readonly number[];
  /** Где бригада звонит и ждёт ответа обучаемого. */
  readonly calling: readonly number[];
} {
  const pick = (alert: TileAlert) =>
    tiles
      .filter((tile) => tile.alert === alert)
      .map((tile) => tile.workstationNumber);
  return {
    soon: pick("soon"),
    overdue: pick("overdue"),
    calling: tiles
      .filter((tile) => tile.brigadeWaitS !== null)
      .map((tile) => tile.workstationNumber),
  };
}
