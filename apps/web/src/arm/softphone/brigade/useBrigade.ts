// Учебные сведения о ходе реагирования: ручной выбор бригад и подтверждённое
// предъявление выданных сервером сообщений. Правила — в `evidence.ts` и
// `logic.ts`, здесь только связь с очередью событий, звуком и данными C-04.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CardEvent } from "../../../shared/api";
import { useSession } from "../../../shared/session";
import { reportMayStart } from "../speech";
import { confirmDial } from "../dialConfirmation";
import { createVoices, type Voices } from "../voices";
import type { BrigadeData } from "./data";
import {
  type Attempt,
  brigadesChanged,
  EMPTY_LEDGER,
  type FailureReason,
  type InformationEvidence,
  type Ledger,
  normalizeBrigades,
  settle,
} from "./evidence";
import {
  type BoardRow,
  type BrigadeQuestion,
  directBlock,
  forcesBoard,
  openQuestion,
  pendingMessages,
  presentedMessages,
} from "./logic";
import type { CardState } from "../../cardModel";
import { replyHowPayload, type ReplyHow } from "./voiceReply";

type CallTarget = BrigadeData["targets"][number];

export interface Listening {
  /** Ответ на текущий звонок; `null` — разговора ещё не было. */
  readonly talkStartedAt: number | null;
  /**
   * Бригада на линии; `null` — разговора с бригадой нет. Доклад звучит сам только в
   * разговоре с той бригадой, что его выдала: не после отбоя и не в чужом звонке.
   */
  readonly brigadeId: string | null;
  /**
   * Бригада, снятая с удержания, повторила свой вопрос и ждёт ответа в его сроке (HQ-058,
   * `holdsNews`): новая реплика ждёт ответа или срока.
   */
  readonly hold?: boolean;
}

export interface BrigadeInput {
  readonly cardId: string;
  readonly data: BrigadeData;
  readonly sessionFinished: boolean;
  /** Статус карточки: бригаду направляют только после «Принята»; `null` — неизвестен. */
  readonly cardState?: CardState | null;
  /** Кто на линии и с какого момента: доклад ждёт, пока диспетчер представится. */
  readonly listen?: () => Listening;
  /**
   * На линии ещё звучит другая реплика (повтор адреса, ответ бригады записью банка): доклад
   * ждёт её конца, а не звучит поверх (проверка 17.10).
   */
  readonly quiet?: boolean;
}

export interface BrigadeView {
  /** Статус карточки, которого бригада ждёт перед следующим докладом; null — не ждёт. */
  readonly awaiting:
    | NonNullable<BrigadeData["training"]>["awaiting_state"]
    | null;
  readonly available: boolean;
  /** Бригады, которыми диспетчер располагает на этой карточке (28.09). */
  readonly brigades: BrigadeData["brigades"];
  /** Бригада → номер происшествия, где она занята; на эту карточку её не направить. */
  readonly busy: ReadonlyMap<string, string>;
  /** Табло сил: номер и состояние каждой доступной бригады. */
  readonly board: readonly BoardRow[];
  /** Почему бригаду сейчас не направить (нет решения «Принята»); `null` — можно. */
  readonly block: string | null;
  /** Почему выбор не отправлен (бригаду только что заняли, нет связи); `null` — отправлен. */
  readonly commitNote: string | null;
  /** Прямые номера направленных бригад — по ним приходят доклады. */
  readonly targets: readonly CallTarget[];
  readonly selected: readonly string[];
  readonly committed: readonly string[];
  readonly toggle: (brigadeId: string) => void;
  readonly commit: () => void;
  /** Предъявленные доклады остаются на виду: по ним пишется комментарий. */
  readonly accepted: readonly InformationEvidence[];
  /** Выданный, но ещё не предъявленный доклад. */
  readonly current: InformationEvidence | null;
  readonly playing: boolean;
  /** Сколько ещё звучать докладу, мс; `null` — не звучит или конец неизвестен (HQ-052). */
  readonly playLeftMs: () => number | null;
  /** Доклад готов, но бригада ещё дослушивает диспетчера (первые 2 с). */
  readonly listening: boolean;
  readonly note: string | null;
  /** Повтор аудио, пока доклад не предъявлен. */
  readonly replay: () => void;
  /** Явное подтверждение прочтения текстового доклада. */
  readonly confirmRead: () => void;
  /** На линии сменился собеседник — проверить, не пора ли бригаде докладывать. */
  readonly recheck: () => void;
  /** Вопрос бригады в разговоре `callId`, на который ещё не ответили (DT-10). */
  readonly question: (
    callId: string | null,
    brigadeId?: string | null,
  ) => BrigadeQuestion | null;
  /**
   * Ответ бригаде вариантом или голосом (DT-16): событие `brigade_reply`, бригада ответит
   * в разговоре. `how` — как дан ответ; без него — вариантом.
   */
  readonly reply: (
    callId: string,
    deliveryId: string,
    optionKey: string,
    how?: ReplyHow,
  ) => void;
  /** Бригады, выехавшие по вводной (GP-05): только подтверждённые сервером. */
  readonly dispatched: readonly string[];
  /** Сказанное бригаде вне вопроса и не вводная (GP-11): событие `brigade_said` в журнал. */
  readonly say: (callId: string, text: string) => void;
  /** «Принял» на «Как приняли?» (TC-01): событие `report_confirmed` в журнал карточки. */
  readonly confirm: (
    callId: string,
    deliveryId: string,
    text: string,
    accepted?: () => void,
  ) => void;
  /** Полная вводная бригаде (GP-05): событие `brigade_briefing`, бригада выезжает. */
  readonly brief: (
    callId: string,
    brigadeId: string,
    mode: "voice" | "parts",
    text: string,
  ) => void;
}

export function useBrigade(input: BrigadeInput): BrigadeView {
  const { realtime } = useSession();
  const { cardId, data, sessionFinished, quiet = false } = input;
  const block = directBlock(input.cardState ?? null);
  const [touched, setTouched] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [optimistic, setOptimistic] = useState<readonly string[] | null>(null);
  const [presentedHere, setPresentedHere] = useState<readonly string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [commitNote, setCommitNote] = useState<string | null>(null);
  const committing = useRef(false);
  const voicesRef = useRef<Voices | null>(null);
  const ledgersRef = useRef(new Map<string, Ledger>());
  const autoPlayedRef = useRef(new Set<string>());
  const listenRef = useRef(input.listen);
  listenRef.current = input.listen;
  const [listening, setListening] = useState(false);
  const [recheck, setRecheck] = useState(0);
  const confirmations = useRef(new Map<string, () => void>());
  const confirmScope = useRef({ cardId, realtime, sessionFinished });
  if (
    confirmScope.current.cardId !== cardId ||
    confirmScope.current.realtime !== realtime ||
    confirmScope.current.sessionFinished !== sessionFinished
  )
    confirmScope.current = { cardId, realtime, sessionFinished };
  useEffect(() => {
    const pending = confirmations.current;
    return () => {
      for (const dispose of pending.values()) dispose();
      pending.clear();
    };
  }, [cardId, realtime, sessionFinished]);
  const finishedRef = useRef(sessionFinished);
  finishedRef.current = sessionFinished;

  useEffect(() => {
    const created = createVoices();
    voicesRef.current = created;
    return () => {
      voicesRef.current = null;
      created.cancel();
    };
  }, []);

  // Завершение занятия останавливает звук и не выдаёт молчание за доклад.
  useEffect(() => {
    if (sessionFinished) voicesRef.current?.cancel();
  }, [sessionFinished]);

  const serverSelected = useMemo(
    () => normalizeBrigades(data.training?.selected_brigade_ids ?? []),
    [data.training],
  );
  const committed = optimistic ?? serverSelected;

  // Сколько бригад доступно и какие заняты — решает сервер; старый сервер этого
  // не присылает, тогда доступны все активные бригады службы.
  const availableIds = data.training?.available_brigade_ids;
  const brigades = useMemo(
    () =>
      availableIds
        ? data.brigades.filter(
            (item) =>
              availableIds.includes(item.id) || committed.includes(item.id),
          )
        : data.brigades,
    [data.brigades, availableIds, committed],
  );
  const busyList = data.training?.busy_brigades;
  const busy = useMemo(
    () =>
      new Map(
        (busyList ?? [])
          .filter((item) => !committed.includes(item.brigade_id))
          .map((item) => [item.brigade_id, item.card_number]),
      ),
    [busyList, committed],
  );

  // Сервер подтвердил набор — оптимистичное значение больше не нужно.
  useEffect(() => {
    if (optimistic && !brigadesChanged(optimistic, serverSelected))
      setOptimistic(null);
  }, [optimistic, serverSelected]);

  const selectedView = touched ? selected : committed;

  const send = useCallback(
    (event: CardEvent) => realtime.enqueue(cardId, event),
    [realtime, cardId],
  );

  const toggle = useCallback(
    (brigadeId: string) => {
      if (busy.has(brigadeId)) return;
      setTouched(true);
      setSelected(
        selectedView.includes(brigadeId)
          ? selectedView.filter((id) => id !== brigadeId)
          : [...selectedView, brigadeId],
      );
    },
    [selectedView, busy],
  );

  const reload = data.reload;
  const commitNow = useCallback(async () => {
    // Только доступные и свободные бригады своей ДДС: отказ сервера остановил бы
    // очередь карточки.
    const known = new Set(brigades.map((item) => item.id));
    const next = normalizeBrigades(
      selectedView.filter((id) => known.has(id) && !busy.has(id)),
    );
    // До решения «Принята» сервер отклонит выбор (409) — событие не отправляем.
    if (
      committing.current ||
      sessionFinished ||
      block !== null ||
      next.length === 0 ||
      !brigadesChanged(committed, next)
    )
      return;
    // Занятость читаем заново: бригаду могли только что направить на другое
    // происшествие, а сведения этой карточки ещё не обновились.
    committing.current = true;
    const fresh = await reload();
    committing.current = false;
    if (!fresh) {
      setCommitNote("Нет связи с сервером — направьте бригаду чуть позже.");
      return;
    }
    const already = normalizeBrigades(fresh.selected_brigade_ids ?? []);
    const taken = new Set(
      (fresh.busy_brigades ?? []).map((item) => item.brigade_id),
    );
    const allowed = fresh.available_brigade_ids;
    if (
      next.some(
        (id) =>
          !already.includes(id) &&
          (taken.has(id) || (allowed !== undefined && !allowed.includes(id))),
      )
    ) {
      setCommitNote(
        "Бригаду только что направили на другое происшествие — выберите свободную.",
      );
      return;
    }
    setCommitNote(null);
    if (!brigadesChanged(already, next)) {
      setTouched(false);
      return;
    }
    setOptimistic(next);
    setTouched(false);
    void send({
      client_event_id: crypto.randomUUID(),
      client_ts: new Date().toISOString(),
      type: "brigades_select",
      payload: { brigade_ids: next },
    } satisfies CardEvent);
  }, [
    brigades,
    busy,
    block,
    selectedView,
    committed,
    sessionFinished,
    reload,
    send,
  ]);
  const commit = useCallback(() => void commitNow(), [commitNow]);

  const messages = data.training?.messages;
  const accepted = useMemo(() => presentedMessages(messages ?? []), [messages]);
  const current = useMemo(
    () =>
      pendingMessages(messages ?? []).find(
        (item) => !presentedHere.includes(item.delivery.delivery_id),
      ) ?? null,
    [messages, presentedHere],
  );

  /** Разрешает попытку: сначала журнал, потом событие. */
  const resolveAttempt = useCallback(
    (attempt: Attempt, outcome: "presented" | FailureReason) => {
      const ledger = ledgersRef.current.get(attempt.deliveryId) ?? EMPTY_LEDGER;
      const result = settle(ledger, attempt, outcome);
      if (result.conflict) {
        setNote("Эта попытка уже учтена — второго сообщения не будет.");
        return;
      }
      ledgersRef.current.set(attempt.deliveryId, {
        state: result.state,
        settled: result.settled,
      });
      // После завершения занятия новые события не отправляются.
      if (result.emit && !finishedRef.current)
        void send({
          client_event_id: crypto.randomUUID(),
          client_ts: new Date().toISOString(),
          type: result.emit.type,
          payload: result.emit.payload,
        } as CardEvent).finally(data.refresh);
      if (result.state === "presented")
        setPresentedHere((ids) => [...ids, attempt.deliveryId]);
    },
    [send, data.refresh],
  );

  /** Проигрывает выданный доклад. Предъявление — только по концу звука. */
  const present = useCallback(
    async (item: InformationEvidence) => {
      const { delivery } = item;
      const audio = delivery.message.audio;
      // playback_id создаётся до попытки и живёт ровно одну попытку.
      const attempt: Attempt = {
        playbackId: crypto.randomUUID(),
        deliveryId: delivery.delivery_id,
        messageVersion: delivery.message.version,
        audioVersion: audio?.version ?? null,
        channel: "audio",
      };
      setPlaying(true);
      setNote(null);
      const played = (await voicesRef.current?.playAsset(
        audio?.url ?? null,
        Math.max(1200, audio?.duration_ms ?? 1200),
      )) ?? { outcome: "failed" as const, startedInMs: null, note: null };
      setPlaying(false);
      // Оборвали (отбой, удержание, другой звук) — попытка не засчитана и не провалена:
      // доклад прозвучит снова, когда линия освободится.
      if (played.outcome === "cancelled") {
        autoPlayedRef.current.delete(delivery.delivery_id);
        return;
      }
      if (played.outcome === "played") {
        resolveAttempt(attempt, "presented");
        return;
      }
      resolveAttempt(attempt, audio ? "playback_error" : "audio_unavailable");
      setNote(
        played.note ?? "Доклад не прозвучал — повторите, он не засчитан.",
      );
    },
    [resolveAttempt],
  );

  // Бригада докладывает сама: выданное аудио звучит один раз автоматически,
  // дальше — по кнопке повтора или «Повторите доклад». Сначала она дослушивает
  // диспетчера: не раньше 2 с после ответа (speech.ts).
  useEffect(() => {
    if (!current || playing || sessionFinished || quiet) return;
    const id = current.delivery.delivery_id;
    if (
      current.state !== "delivered" ||
      current.delivery.message.audio === null ||
      autoPlayedRef.current.has(id)
    )
      return;
    const heard = listenRef.current?.();
    if (heard && heard.brigadeId !== current.delivery.brigade_id) {
      setListening(false);
      return;
    }
    if (heard?.hold) {
      setListening(false);
      const timer = setTimeout(() => setRecheck((value) => value + 1), 250);
      return () => clearTimeout(timer);
    }
    if (
      heard &&
      heard.talkStartedAt !== null &&
      !reportMayStart({ now: Date.now(), talkStartedAt: heard.talkStartedAt })
    ) {
      setListening(true);
      const timer = setTimeout(() => setRecheck((value) => value + 1), 150);
      return () => clearTimeout(timer);
    }
    setListening(false);
    autoPlayedRef.current.add(id);
    void present(current);
  }, [current, playing, sessionFinished, quiet, present, recheck]);

  const playLeftMs = useCallback(
    () => voicesRef.current?.remainingMs() ?? null,
    [],
  );

  const recheckNow = useCallback(() => setRecheck((value) => value + 1), []);

  const replay = useCallback(() => {
    if (!current || playing || sessionFinished) return;
    if (current.delivery.message.audio === null) return;
    void present(current);
  }, [current, playing, sessionFinished, present]);

  const confirmRead = useCallback(() => {
    if (!current || sessionFinished) return;
    const { delivery } = current;
    if (delivery.message.audio !== null) return;
    resolveAttempt(
      {
        playbackId: crypto.randomUUID(),
        deliveryId: delivery.delivery_id,
        messageVersion: delivery.message.version,
        audioVersion: null,
        channel: "text",
      },
      "presented",
    );
  }, [current, sessionFinished, resolveAttempt]);

  const targets = useMemo(
    () =>
      data.targets.filter(
        (item) =>
          item.brigade_id !== null && committed.includes(item.brigade_id),
      ),
    [data.targets, committed],
  );
  const contactList = data.training?.brigade_contacts;
  const contacts = useMemo(
    () =>
      new Map(
        (contactList ?? []).map((item) => [
          item.brigade_id,
          item.last_contact_at,
        ]),
      ),
    [contactList],
  );
  const board = useMemo(
    () => forcesBoard(brigades, data.targets, committed, busy, contacts),
    [brigades, data.targets, committed, busy, contacts],
  );

  // Ответ уходит в очередь событий; до ответа сервера варианты больше не показываем.
  const [answered, setAnswered] = useState<readonly string[]>([]);
  const question = useCallback(
    (callId: string | null, brigadeId: string | null = null) =>
      openQuestion(messages ?? [], callId, answered, brigadeId),
    [messages, answered],
  );
  const reply = useCallback(
    (callId: string, deliveryId: string, optionKey: string, how?: ReplyHow) => {
      if (sessionFinished) return;
      setAnswered((ids) => [...ids, deliveryId]);
      void send({
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        type: "brigade_reply",
        payload: {
          call_id: callId,
          delivery_id: deliveryId,
          option_key: optionKey,
          ...replyHowPayload(how),
        },
      } satisfies CardEvent).finally(data.refresh);
    },
    [send, sessionFinished, data.refresh],
  );

  // enqueue подтверждает лишь запись в outbox; выезд подтверждает выдача сервера.
  const brief = useCallback(
    (
      callId: string,
      _brigadeId: string,
      mode: "voice" | "parts",
      text: string,
    ) => {
      if (sessionFinished) return;
      void send({
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        type: "brigade_briefing",
        payload: { call_id: callId, mode, text },
      } satisfies CardEvent).then(data.refresh, () => {
        setNote(
          "Не удалось отправить вводную. Повторите её после восстановления связи.",
        );
        data.refresh();
      });
    },
    [send, sessionFinished, data.refresh],
  );
  const say = useCallback(
    (callId: string, text: string) => {
      if (sessionFinished || !text.trim()) return;
      void send({
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        type: "brigade_said",
        payload: { call_id: callId, text: text.trim().slice(0, 1000) },
      } satisfies CardEvent).finally(data.refresh);
    },
    [send, sessionFinished, data.refresh],
  );
  const confirm = useCallback(
    (
      callId: string,
      deliveryId: string,
      text: string,
      accepted?: () => void,
    ) => {
      if (sessionFinished || !text.trim()) return;
      const key = JSON.stringify([callId, deliveryId]);
      if (confirmations.current.has(key)) return;
      const scope = confirmScope.current;
      // Резервируем до записи в очередь: возможны синхронная квитанция и повторный щелчок.
      confirmations.current.set(key, () => {});
      let settled = false;
      const finish = () => {
        settled = true;
        confirmations.current.delete(key);
        data.refresh();
      };
      const attempt = confirmDial(
        realtime,
        cardId,
        {
          client_event_id: crypto.randomUUID(),
          client_ts: new Date().toISOString(),
          type: "report_confirmed",
          payload: {
            call_id: callId,
            delivery_id: deliveryId,
            text: text.trim().slice(0, 1000),
          },
        },
        {
          isCurrent: () => confirmScope.current === scope,
          accepted: () => {
            finish();
            accepted?.();
          },
          rejected: (message) => {
            finish();
            setNote(message);
          },
        },
      );
      if (!settled) confirmations.current.set(key, attempt.dispose);
    },
    [realtime, cardId, sessionFinished, data.refresh],
  );
  const dispatched = serverSelected;

  return {
    // Статус, которого бригада ждёт перед следующим докладом. Сервер отдаёт его
    // только в занятии с подсказками (тренировка), в контрольном — null.
    awaiting: data.training?.awaiting_state ?? null,
    available: !data.unavailable && brigades.length > 0,
    brigades,
    busy,
    board,
    block,
    commitNote,
    targets,
    selected: selectedView,
    committed,
    toggle,
    commit,
    accepted,
    current,
    playing,
    playLeftMs,
    listening: listening && current !== null && !playing,
    note,
    replay,
    confirmRead,
    recheck: recheckNow,
    question,
    reply,
    dispatched,
    say,
    confirm,
    brief,
  };
}
