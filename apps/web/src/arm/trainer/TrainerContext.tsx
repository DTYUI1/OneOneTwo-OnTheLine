// Управление обучением (DT-18): запуск этапов как тренировок, окно «Как устроено
// обучение», окна «Этап пройден», показ курсором и «Беру управление». Провайдер стоит
// над АРМ (ArmPage): «Тренировка», этапы в шапке списка, подсказка у элемента и разбор
// зовут его через useTrainer().
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api-client/schema";
import { api as server, csrfToken } from "../../shared/api";
import { SessionContext } from "../../shared/session";
import { ConfirmDialog } from "../ConfirmDialog";
import { settleCardActions } from "../useCardActions";
import { takeOverSession } from "../practice/practiceModel";
import { usePracticeStart } from "../practice/usePracticeStart";
import { startDemo, stopDemo } from "./autopilot";
import {
  beginTakeOver,
  expertSource,
  finishTakeOver,
  doneStages,
  introSeen,
  linkExpertCard,
  markIntroSeen,
  markStageDone,
  sessionMode,
  sessionStage,
  setLastStage,
  setSessionMode,
  takeOverUnconfirmed,
  type CardMode,
  type Stage,
} from "./stages";
import { trainerStore, useTrainerState } from "./trainerStore";
import armStyles from "../ArmPage.module.css";

/**
 * Окно обучения: условности перед первым звонком, «Этап пройден» или выбор этапа у портрета
 * наставника (`mentor`, на любой ступени; капитан, 20.10).
 */
export type TrainerDialog =
  | { readonly kind: "intro" }
  | { readonly kind: "mentor" }
  | { readonly kind: "watchDone" }
  | {
      readonly kind: "togetherDone";
      readonly cardId: string;
      readonly helps: number;
    };

export interface TrainerApi {
  /** Окно «Как устроено обучение» этот пользователь уже видел. */
  introSeen: () => boolean;
  /** Пройденные этапы этого пользователя — ✓ на кнопках этапов. */
  done: () => Set<Stage>;
  openIntro: () => void;
  /** «Тренировка с Николаем Сергеевичем»: выбор этапа — портрет в шапке списка. */
  openMentor: () => void;
  /** Начать этап: новая тренировка в его режиме. */
  startStage: (stage: Stage) => void;
  /** «Как сделал бы опытный»: курсор проходит ту же карточку упражнения. */
  watchExpert: (cardId: string) => void;
  /** «Беру управление»: показ останавливается, дальше «Вместе» с того же места. */
  takeOver: () => Promise<void>;
  dialog: TrainerDialog | null;
  closeDialog: () => void;
  /** Режим открытой карточки тренировки; null — карточки нет или это занятие. */
  mode: CardMode | null;
  /** Строка запуска тренировки («карточка откроется сама», ошибка). */
  note: string;
  /** Блокировка запуска новой тренировки; не управляет локальной паузой. */
  busy: boolean;
  blockedReason: string;
  takingOver: boolean;
  /** Исход POST ещё неизвестен: снимать паузу нельзя даже после ошибки сети. */
  takeOverUncertain: boolean;
}

const TrainerContext = createContext<TrainerApi | null>(null);

interface TakeOverState {
  readonly pending: boolean;
  readonly uncertain: boolean;
  readonly note: string;
}

/** API обучения; null — вне АРМ (стенды, преподаватель). */
export function useTrainer(): TrainerApi | null {
  return useContext(TrainerContext);
}

const DEMO_BLOCKED =
  "Сейчас показывает тренажёр. Чтобы нажимать самому — «Беру управление» в этой подсказке.";
// Показ опытного управления не отдаёт (кнопки «Беру управление» у него нет): только пауза.
const EXPERT_BLOCKED =
  "Сейчас показывает опытный. Остановить показ — «Пауза» в этой подсказке.";
const TAKE_OVER_UNCERTAIN =
  "Не удалось подтвердить передачу управления. Показ на паузе; проверьте соединение и повторите «Беру управление».";

export function TrainerProvider({
  onReview,
  children,
}: {
  /** Открыть разбор карточки. */
  readonly onReview: (cardId: string) => void;
  readonly children: ReactNode;
}) {
  const practice = usePracticeStart();
  const queries = useQueryClient();
  const realtime = useContext(SessionContext)?.realtime;
  // Отметки этапов и окно обучения — свои у каждого пользователя (stages.ts).
  const userId = useContext(SessionContext)?.user.id ?? "";
  const { card, demo } = useTrainerState();
  const [dialog, setDialog] = useState<TrainerDialog | null>(null);
  // Идёт другая тренировка: новый этап сначала спрашивает, прервать ли её.
  const [asking, setAsking] = useState<(() => void) | null>(null);
  // Запрос принадлежит занятию, не экрану: поздний ответ A не снимает паузу B.
  const takeOversRef = useRef(new Map<string, TakeOverState>());
  const [takeOvers, setTakeOvers] = useState(takeOversRef.current);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const updateTakeOver = useCallback(
    (id: string, patch: Partial<TakeOverState>) => {
      takeOversRef.current.set(id, {
        pending: false,
        uncertain: takeOverUnconfirmed(id),
        note: "",
        ...takeOversRef.current.get(id),
        ...patch,
      });
      if (mounted.current) setTakeOvers(new Map(takeOversRef.current));
    },
    [],
  );
  const takeOverState = card ? takeOvers.get(card.sessionId) : undefined;
  const takingOver = takeOverState?.pending ?? false;
  const takeOverUncertain =
    takeOverState?.uncertain ??
    (card ? takeOverUnconfirmed(card.sessionId) : false);
  const takeOverNote =
    takeOverState?.note ?? (takeOverUncertain ? TAKE_OVER_UNCERTAIN : "");
  const review = useRef(onReview);
  review.current = onReview;

  useEffect(() => {
    if (practice.blockedReason) {
      setDialog(null);
      setAsking(null);
    }
  }, [practice.blockedReason]);

  const mode = card?.practice ? sessionMode(card.sessionId) : null;

  const launch = useCallback(
    (go: () => void) => {
      if (practice.disabled) return;
      if (card) updateTakeOver(card.sessionId, { note: "" });
      setDialog(null);
      if (practice.running) setAsking(() => go);
      else go();
    },
    [practice.running, practice.disabled, card, updateTakeOver],
  );
  const startStage = useCallback(
    (stage: Stage) => {
      if (practice.disabled) return;
      markIntroSeen(userId);
      launch(() => {
        stopDemo();
        setLastStage(userId, stage);
        // Все три этапа — учебная карточка ступени 1 (упражнение); «Сам» — без подсказок.
        // Ступень пути запускает «Тренировка: ступень N» (капитан, 20.10).
        void practice.start({ mode: stage });
      });
    },
    [launch, practice, userId],
  );
  const watchExpert = useCallback(
    (cardId: string) =>
      launch(() => {
        stopDemo();
        void practice.start({ mode: "expert", expertFor: cardId });
      }),
    [launch, practice],
  );
  const takeOver = useCallback(async () => {
    const current = trainerStore.get();
    const sessionId = takeOverSession(current.demo, current.card);
    if (!sessionId || takeOversRef.current.get(sessionId)?.pending) return;
    const wasUncertain = takeOverUnconfirmed(sessionId);
    const paused = current.demo?.paused ?? false;
    const isShownCard = () => {
      const now = trainerStore.get().card;
      return (
        now?.sessionId === sessionId && now.cardId === current.card?.cardId
      );
    };
    const isCurrent = () => mounted.current && isShownCard();
    updateTakeOver(sessionId, {
      pending: true,
      uncertain: wasUncertain,
      note: "Передаём управление — подождите подтверждения сервера…",
    });
    const owner = beginTakeOver(sessionId);
    trainerStore.updateDemo({ paused: true });
    const confirm = (data: components["schemas"]["Session"]) => {
      if (!finishTakeOver(sessionId, owner)) return;
      setSessionMode(sessionId, "together");
      queries.setQueryData(["session", sessionId], data);
      updateTakeOver(sessionId, { uncertain: false, note: "" });
      // ACK принадлежит занятию/карточке, а не экземпляру провайдера:
      // после remount отменяем и живой показ, и начатые им async-действия.
      // Другую карточку/занятие и нового owner перехвата не затрагиваем.
      if (isShownCard()) {
        markStageDone(userId, "watch");
        setLastStage(userId, "together");
        if (trainerStore.get().demo?.cardId === current.demo?.cardId)
          stopDemo();
      }
      void queries.invalidateQueries({ queryKey: ["sessions"] });
      void queries.invalidateQueries({ queryKey: ["progress"] });
    };
    try {
      if (realtime && current.card) {
        // enqueue не равен ACK: при offline событие остаётся и может уйти после
        // перехвата. Сначала ждём начатые записи, затем проверяем durable-очередь.
        await settleCardActions(current.card.cardId);
        const pending = await realtime.pending();
        if (!isCurrent()) return;
        if (pending.some((item) => item.cardId === current.card?.cardId)) {
          if (!wasUncertain) finishTakeOver(sessionId, owner);
          updateTakeOver(sessionId, {
            note: "Показ на паузе. Дождитесь отправки очереди действий карточки или разберите её отказ, затем повторите «Беру управление».",
          });
          return;
        }
      }
      const { data, error, response } = await server.POST(
        "/practice/{id}/take-over",
        {
          params: {
            path: { id: sessionId },
            header: { "X-CSRF-Token": csrfToken() },
          },
        },
      );
      // Только явный HTTP-отказ первой попытки разрешает вернуть прежний показ.
      // 5xx/timeout и отказ повтора не доказывают, что прежний POST не был принят.
      if (
        error &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        !wasUncertain
      ) {
        if (!finishTakeOver(sessionId, owner)) return;
        updateTakeOver(sessionId, {
          note: `Не удалось взять управление. ${error.message}`,
        });
        if (isCurrent()) trainerStore.updateDemo({ paused });
        return;
      }
      if (
        !data ||
        data.id !== sessionId ||
        data.settings_snapshot?.demo !== false
      )
        throw new Error("Передача управления не подтверждена");
      confirm(data);
    } catch {
      updateTakeOver(sessionId, { uncertain: true });
      // POST мог уже зафиксировать demo=false: потерянный ответ — не отказ.
      // Курсор не должен доделать зачётную попытку за обучаемого.
      try {
        const { data } = await server.GET("/sessions/{id}", {
          params: { path: { id: sessionId } },
          cache: "no-store",
        });
        if (data?.id === sessionId && data.settings_snapshot?.demo === false) {
          confirm(data);
          return;
        }
      } catch {
        // Пока сверка недоступна, показ остаётся на безопасной паузе.
      }
      // Даже demo=true может быть снимком ДО запоздавшего commit. Снять блокировку
      // может только demo=false или успешный идемпотентный повтор перехвата.
      updateTakeOver(sessionId, {
        note: TAKE_OVER_UNCERTAIN,
      });
    } finally {
      updateTakeOver(sessionId, { pending: false });
    }
  }, [queries, realtime, updateTakeOver, userId]);

  // Показ: карточка тренировки в режиме «Смотрю» или опытного — курсор ведёт её сам.
  const demoCard =
    card &&
    !card.closed &&
    card.canAct &&
    (mode === "watch" || mode === "expert")
      ? card
      : null;
  const demoFor = demo?.cardId ?? null;
  useEffect(() => {
    if (!demoCard || demoFor === demoCard.cardId) return;
    const { cardId, sessionId } = demoCard;
    const expert = mode === "expert";
    startDemo(
      cardId,
      expert,
      () => {
        if (expert) {
          const mine = expertSource(sessionId);
          if (mine) {
            linkExpertCard(mine, cardId);
            review.current(mine);
          }
          return;
        }
        markStageDone(userId, "watch");
        setSessionMode(sessionId, "together");
        setDialog({ kind: "watchDone" });
      },
      takingOver || takeOverUncertain,
    );
  }, [demoCard, demoFor, mode, takingOver, takeOverUncertain, userId]);
  // Ушли с карточки показа — показ останавливается.
  const shownId = card?.cardId ?? null;
  useEffect(() => {
    if (
      demoFor &&
      demoFor !== shownId &&
      !demo?.over &&
      trainerStore.get().demo?.cardId === demoFor
    )
      stopDemo();
  }, [demoFor, shownId, demo?.over]);
  useEffect(() => () => stopDemo(), []);

  // «Вместе» пройдено: карточка закрылась у вас на глазах. «Сам», запущенный этапом, — тоже:
  // ✓ без окна, оценка — в «Моих результатах» (ревью 20.10).
  const closedBefore = useRef<{ id: string; closed: boolean } | null>(null);
  useEffect(() => {
    if (!card) {
      closedBefore.current = null;
      return;
    }
    const before = closedBefore.current;
    closedBefore.current = { id: card.cardId, closed: card.closed };
    const closedNow =
      before?.id === card.cardId && !before.closed && card.closed;
    if (closedNow && mode === "solo" && sessionStage(card.sessionId) === "solo")
      markStageDone(userId, "solo");
    if (closedNow && mode === "together") {
      markStageDone(userId, "together");
      setLastStage(userId, "solo");
      setDialog({
        kind: "togetherDone",
        cardId: card.cardId,
        helps: card.helps,
      });
    }
  }, [card, mode, userId]);

  // Свои щелчки в АРМ и связи во время показа не проходят (макет B, из D).
  const blocking = Boolean(demo && !demo.over);
  useEffect(() => {
    if (!blocking) return;
    let timer = 0;
    const block = (event: Event) => {
      const target = event.target;
      if (
        !event.isTrusted ||
        !(target instanceof Element) ||
        !target.closest("[data-trainer-block]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      trainerStore.setNote(
        trainerStore.get().demo?.expert ? EXPERT_BLOCKED : DEMO_BLOCKED,
      );
      window.clearTimeout(timer);
      timer = window.setTimeout(() => trainerStore.setNote(null), 4000);
    };
    const types = ["pointerdown", "mousedown", "click", "keydown"] as const;
    for (const type of types) document.addEventListener(type, block, true);
    return () => {
      window.clearTimeout(timer);
      trainerStore.setNote(null);
      for (const type of types) document.removeEventListener(type, block, true);
    };
  }, [blocking]);

  const api = useMemo<TrainerApi>(
    () => ({
      introSeen: () => introSeen(userId),
      done: () => doneStages(userId),
      openIntro: () => {
        if (!practice.disabled) setDialog({ kind: "intro" });
      },
      openMentor: () => setDialog({ kind: "mentor" }),
      startStage,
      watchExpert,
      takeOver,
      dialog,
      closeDialog: () => {
        if (dialog?.kind === "intro") markIntroSeen(userId);
        setDialog(null);
      },
      mode,
      note: takeOverNote || practice.note,
      busy: practice.disabled,
      blockedReason: practice.blockedReason,
      takingOver,
      takeOverUncertain,
    }),
    [
      startStage,
      watchExpert,
      takeOver,
      dialog,
      mode,
      practice.note,
      practice.blockedReason,
      practice.disabled,
      takeOverNote,
      takingOver,
      takeOverUncertain,
      userId,
    ],
  );

  return (
    <TrainerContext.Provider value={api}>
      {/* Поверх страницы: исчезая с приходом карточки, строка не сдвигает её. */}
      {api.note && (
        <p role="status" className={armStyles.practiceToast}>
          {api.note}
        </p>
      )}
      {children}
      {asking && (
        <ConfirmDialog
          title="Начать тренировку заново?"
          confirmLabel="Начать заново"
          onConfirm={() => {
            const go = asking;
            setAsking(null);
            go();
          }}
          onCancel={() => setAsking(null)}
        >
          Текущая тренировочная карточка будет прервана.
        </ConfirmDialog>
      )}
    </TrainerContext.Provider>
  );
}
