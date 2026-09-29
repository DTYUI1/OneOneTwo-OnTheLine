// Данные live-доски: занятие, участники, карточки и присутствие.
// Начальное состояние — HTTP и snapshot, дальше только WS.
// Для времени (I-TIME v3) — снимок политики занятия, журналы активных карточек
// и подтверждённое ожидание из разбора попытки; перечитываются по уведомлениям WS.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { useSession } from "../../shared/session";
import {
  type BoardTile,
  buildBoard,
  type Card,
  type CardClock,
  isActive,
  type Service,
  type Session,
  type TimingContext,
} from "./board";
import { latestRunning } from "../console/lessonClock";
import { trainingKey, trainingQuery } from "../../arm/softphone/brigade/data";

export interface LiveBoardView {
  readonly session: Session | null;
  readonly tiles: readonly BoardTile[];
  readonly loading: boolean;
  readonly error: string | null;
}

export function useLiveBoard(sessionId?: string | null): LiveBoardView {
  const { realtime } = useSession();
  const client = useQueryClient();
  const [cards, setCards] = useState<ReadonlyMap<string, Card>>(new Map());
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const seeded = useRef(false);

  const selected = useQuery({
    queryKey: ["session", sessionId],
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const { data, error } = await api.GET("/sessions/{id}", {
        params: { path: { id: sessionId! } },
      });
      if (!data) throw new Error(error?.message ?? "Занятие недоступно.");
      return data;
    },
  });

  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const { data, error } = await api.GET("/users");
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
    staleTime: 60_000,
  });

  const initial = useQuery({
    queryKey: ["live-board"],
    queryFn: async () => {
      const [sessionList, cardList, serviceList] = await Promise.all([
        api.GET("/sessions"),
        api.GET("/cards"),
        api.GET("/services"),
      ]);
      if (!sessionList.data || !cardList.data || !serviceList.data)
        throw new Error(
          sessionList.error?.message ??
            cardList.error?.message ??
            serviceList.error?.message ??
            "Нет связи с сервером.",
        );
      return {
        sessions: sessionList.data,
        cards: cardList.data,
        services: serviceList.data as Service[],
      };
    },
  });

  // HTTP отдаёт стартовое состояние один раз; дальше доску ведёт WS.
  useEffect(() => {
    if (!initial.data || seeded.current) return;
    seeded.current = true;
    setSessions(initial.data.sessions);
    setCards(new Map(initial.data.cards.map((card) => [card.id, card])));
  }, [initial.data]);

  const putCard = useCallback((card: Card) => {
    setCards((current) => new Map(current).set(card.id, card));
  }, []);

  useEffect(() => {
    return realtime.subscribe((event) => {
      switch (event.type) {
        case "snapshot":
          // Snapshot заменяет отображаемое состояние, а не дополняет его.
          seeded.current = true;
          setCards(new Map(event.payload.cards.map((card) => [card.id, card])));
          setSessions(event.payload.sessions);
          // После переподключения журналы могли уйти вперёд.
          void client.invalidateQueries({ queryKey: ["card-events"] });
          void client.invalidateQueries({ queryKey: ["card-analysis"] });
          return;
        case "card.appeared":
        case "card.updated":
          putCard(event.payload);
          // Новое действие по карточке — новые границы времени.
          void client.invalidateQueries({
            queryKey: ["card-events", event.payload.id],
          });
          void client.invalidateQueries({
            queryKey: ["card-analysis", event.payload.id],
          });
          return;
        case "training.updated":
          // Выдан доклад бригады — закрылся интервал ожидания сведений;
          // или бригада позвонила сама — её вызов виден на плитке.
          void client.invalidateQueries({
            queryKey: ["card-analysis", event.payload.card_id],
          });
          void client.invalidateQueries({
            queryKey: trainingKey(event.payload.card_id),
          });
          return;
        case "session.started":
        case "session.finished": {
          const updated = event.payload;
          setSessions((current) => {
            const rest = current.filter((item) => item.id !== updated.id);
            return [...rest, updated];
          });
          return;
        }
        case "presence":
          setOnline((current) => {
            const next = new Set(current);
            if (event.payload.online) next.add(event.payload.user_id);
            else next.delete(event.payload.user_id);
            return next;
          });
          return;
        default:
          return;
      }
    });
  }, [realtime, putCard, client]);

  // Секунда — шаг, которым живут нормативы 30 с и 180 с.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const session = useMemo(
    // undefined сохраняет автоподбор на отдельном стенде; null — явный пустой выбор.
    () =>
      sessionId === undefined
        ? (latestRunning(sessions) ?? null)
        : (selected.data ?? null),
    [sessions, sessionId, selected.data],
  );

  const lifecycle = useQuery({
    queryKey: ["lifecycle", session?.id],
    enabled: Boolean(session),
    queryFn: async () => {
      const { data } = await api.GET("/sessions/{id}/lifecycle", {
        params: { path: { id: session!.id } },
      });
      return data ?? null;
    },
    staleTime: 60_000,
  });

  const timing = useMemo<TimingContext | null>(
    () =>
      session && !lifecycle.isPending
        ? {
            sessionId: session.id,
            // Нет политики (старое занятие или сервер без C-02) — legacy v1 по I-TIME.
            policy: lifecycle.data?.timing_policy ?? null,
            legacyReactionS: session.settings_snapshot.reaction_normative_s,
            legacyHandlingS: session.settings_snapshot.handling_normative_s,
          }
        : null,
    [session, lifecycle.isPending, lifecycle.data],
  );

  const active = useMemo(
    () =>
      session
        ? [...cards.values()].filter(
            (card) => card.session_id === session.id && isActive(card),
          )
        : [],
    [cards, session],
  );

  const events = useQueries({
    queries: active.map((card) => ({
      queryKey: ["card-events", card.id],
      queryFn: async () => {
        const { data, error } = await api.GET("/cards/{id}/events", {
          params: { path: { id: card.id } },
        });
        if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
        return data;
      },
    })),
  });

  // Ожидание сведений нужно только v3 и только после первичного статуса:
  // до него идёт реакция, а её ожидание не касается.
  const needsWaiting = timing?.policy?.timing_version === 3;
  const waiting = useQueries({
    queries: active.map((card) => ({
      queryKey: ["card-analysis", card.id],
      enabled:
        needsWaiting && card.state !== "added" && card.state !== "received",
      queryFn: async () => {
        const { data, error } = await api.GET("/cards/{id}/analysis", {
          params: { path: { id: card.id } },
        });
        if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
        return data;
      },
    })),
  });

  // Бригада звонит сама (CardTraining.incoming): видно, кто не отвечает.
  const training = useQueries({
    queries: active.map((card) => ({
      ...trainingQuery(card.id),
      enabled: card.opened_at !== null,
      retry: false,
    })),
  });

  const clocks = useMemo(
    () =>
      new Map<string, CardClock>(
        active.map((card, index) => [
          card.id,
          {
            events: events[index]?.data,
            waitingS: waiting[index]?.data?.timing.waiting_s ?? null,
            callingSince:
              training[index]?.data?.incoming?.[0]?.started_at ?? null,
          },
        ]),
      ),
    [active, events, waiting, training],
  );

  const tiles = useMemo(
    () =>
      buildBoard({
        session,
        users: users.data ?? [],
        cards: [...cards.values()],
        services: initial.data?.services ?? [],
        online,
        now,
        timing,
        clocks,
      }),
    [session, users.data, cards, initial.data, online, now, timing, clocks],
  );

  return {
    session,
    tiles,
    loading:
      initial.isPending ||
      users.isPending ||
      (Boolean(sessionId) && selected.isPending),
    error:
      initial.isError || users.isError || selected.isError
        ? "Не удалось загрузить занятие."
        : null,
  };
}
