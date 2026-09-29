// Рабочее поле ДДС: список происшествий и отдельная страница карточки (arm_dds/06–07).
// Новые карточки прилетают по WS и не прерывают работу с текущей — параллельные карточки (Q&A Q11).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Card } from "../shared/api";
import { useSession } from "../shared/session";
import {
  formatAddress,
  formatDuration,
  reactionTimer,
  isClosed,
  newestFirst,
  STATE_LABELS,
  type Service,
  type Settings,
} from "./cardModel";
import { IncidentCard } from "./IncidentCard";
import { useCardActions } from "./useCardActions";
import { useNow } from "./useNow";
import { PendingActions } from "./PendingActions";
import { ResultsPanel } from "./results";
import { useHelpGuide } from "../shared/help/HelpProvider";
import {
  ARM_GUIDE,
  CARD_GUIDE,
  RESULTS_GUIDE,
  REFERENCE_GUIDE,
} from "./help/topics";
import { useHelpEnabled } from "./help/useHelpEnabled";
import { ReferencePanel } from "./ReferencePanel";
import { QuizButton } from "./quiz/QuizButton";
import { ProgressButton } from "./progress/ProgressButton";
import { PracticeButton } from "./practice/PracticeButton";
import { useParticipant } from "./useParticipant";
import { useCardTiming } from "./useTiming";
import { IncidentTabs } from "./IncidentTabs";
import { ParallelBanner, ParallelNotice } from "./ParallelNotice";
import { SwitchCallDialog } from "./SwitchCallDialog";
import { callInterruptedBy, type ActiveCall } from "./callGuard";
import {
  emptyListText,
  listKey,
  trainingLabel,
  trainingStep,
} from "./listModel";
import styles from "./ArmPage.module.css";

const DEFAULT_SETTINGS: Pick<
  Settings,
  "reaction_normative_s" | "handling_normative_s"
> = { reaction_normative_s: 30, handling_normative_s: 180 };

// На узком экране эти колонки скрываются: время и реакция важнее даты и флага.
const OPTIONAL_COLUMNS = ["Дата", "Постр."];
const COLUMNS = [
  "ЧС",
  "Номер",
  "Дата",
  "Время",
  "Тип происшествия",
  "Постр.",
  "Адрес",
  "Статус службы",
  "Реакция",
];

type ListPosition = {
  search: string;
  x: number;
  y: number;
  tableX: number;
  cardId: string;
};
function readPosition(key: string): ListPosition | undefined {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Строка списка. Доставку (deliver) отправляет вкладка происшествия: она видна и
 * поверх открытой карточки, поэтому новая карточка «показана», даже пока
 * обучаемый работает с другой (IncidentTabs, 27.09).
 */
function IncidentRow({
  card,
  reactionNormativeS,
  now,
  onOpen,
  presented,
}: {
  card: Card;
  reactionNormativeS: number;
  now: number;
  onOpen: () => void;
  presented: boolean;
}) {
  const row = useRef<HTMLTableRowElement>(null);
  const [inViewport, setInViewport] = useState(false);
  useEffect(() => {
    // Список может содержать сотни старых карточек. Их истории не должны
    // занимать соединения раньше строк, которые диспетчер действительно видит.
    const observer = new IntersectionObserver(([entry]) =>
      setInViewport(entry.isIntersecting),
    );
    if (row.current) observer.observe(row.current);
    return () => observer.disconnect();
  }, []);
  const shown = presented && inViewport;

  // Реакция — по общему расчёту C-02: в v3 от направления карточки до первичного
  // статуса «Принята / Не принята»; открытие её не останавливает.
  const timing = useCardTiming(card, now, shown);
  const legacy = reactionTimer(card, reactionNormativeS, now);
  const timer = timing
    ? {
        seconds: Math.floor(timing.reaction.seconds ?? 0),
        overdue: timing.reaction.over,
        stopped: !timing.reaction.running,
      }
    : legacy;
  const appeared = new Date(card.appeared_at);
  const rowClass =
    timer.overdue && !timer.stopped ? styles.rowOverdue : styles.row;
  return (
    <>
      <tr
        ref={row}
        data-card-id={card.id}
        onClick={onOpen}
        tabIndex={0}
        onKeyDown={(event) => {
          // Реестр без мыши: Enter/пробел открывают карточку, ↑/↓ — соседняя
          // карточка. Строка «Описание:» фокуса не получает и пропускается.
          const row = event.currentTarget;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const rows = [
              ...(row.parentElement?.querySelectorAll<HTMLElement>(
                "[data-card-id]",
              ) ?? []),
            ];
            const next =
              rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
            next?.focus();
          }
        }}
        className={`${rowClass} ${styles.mainRow}`}
      >
        <td>{card.source.emergency ? "ЧС" : ""}</td>
        <td>{card.source.number}</td>
        <td className={styles.optional}>
          {appeared.toLocaleDateString("ru-RU")}
        </td>
        <td>{appeared.toLocaleTimeString("ru-RU")}</td>
        <td>{card.source.incident_class}</td>
        <td className={styles.optional}>
          {card.source.victims ? "да" : "нет"}
        </td>
        <td>{formatAddress(card.source.address)}</td>
        <td>
          {/* Занятие завершили раньше, чем карточку закрыли: работа по ней прервана. */}
          {card.interrupted_at && !isClosed(card)
            ? "Прервана"
            : STATE_LABELS[card.state]}
        </td>
        <td className={timer.overdue ? styles.timerOverdue : styles.timer}>
          {formatDuration(timer.seconds)}
        </td>
      </tr>
      {/* Вторая строка реестра — описание, как в arm_dds/03: по нему вызовы
        различают взглядом. Щелчок по ней открывает ту же карточку. */}
      <tr className={rowClass} onClick={onOpen}>
        <td colSpan={COLUMNS.length} className={styles.description}>
          <span>Описание:</span> {card.source.description}
        </td>
      </tr>
    </>
  );
}

export function ArmPage() {
  const { user } = useSession();
  const now = useNow();
  const navigate = useNavigate();
  const location = useLocation();
  const path = useParams()["*"] ?? "";
  const openedId = path.startsWith("cards/") ? path.slice(6) : null;
  // Экран результатов: null — закрыт, иначе карточка, с которой начать разбор.
  const results = path === "results";
  const reference = path === "reference";
  const [reviewId, setReviewId] = useState<string | null>(null);
  const positionKey = (id: string) => `arm:return:${user.id}:${id}`;
  const restored = (location.state?.list ??
    (openedId ? readPosition(positionKey(openedId)) : undefined)) as
    | ListPosition
    | undefined;
  const [search, setSearch] = useState(restored?.search ?? "");
  const listPosition = useRef(
    restored ?? { x: 0, y: 0, tableX: 0, cardId: "", search: "" },
  );
  const table = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const isList = !openedId && !results && !reference;
  const restoreList = useRef(true);
  // АРМ сам восстанавливает позицию реестра после карточки. Когда набор строк
  // меняется, привязка прокрутки браузера может сместить эту позицию; на время
  // работы АРМ отключаем её на корне документа.
  useEffect(() => {
    const root = document.documentElement;
    const previousRoot = root.style.overflowAnchor;
    root.style.overflowAnchor = "none";
    return () => {
      root.style.overflowAnchor = previousRoot;
    };
  }, []);
  // Переход к другому происшествию посреди разговора обрывает звонок: сначала спрашиваем.
  const [switching, setSwitching] = useState<{
    call: ActiveCall;
    go: () => void;
  } | null>(null);
  function guarded(targetCardId: string | null, go: () => void) {
    const call = callInterruptedBy(targetCardId);
    if (call) setSwitching({ call, go });
    else go();
  }
  function openCard(id: string) {
    guarded(id, () => goToCard(id));
  }
  function goToCard(id: string) {
    listPosition.current = {
      search,
      x: window.scrollX,
      y: window.scrollY,
      tableX: table.current?.scrollLeft ?? 0,
      cardId: id,
    };
    try {
      // Резерв для браузеров, которые сбрасывают history.state при reload.
      sessionStorage.setItem(
        positionKey(id),
        JSON.stringify(listPosition.current),
      );
    } catch {
      // При запрете хранилища продолжает работать история текущей страницы.
    }
    navigate(`/arm/cards/${encodeURIComponent(id)}`, {
      state: { fromList: true, list: listPosition.current },
    });
  }
  const fromList = location.state?.fromList === true;
  const leaveCard = useCallback(() => {
    if (openedId && fromList) navigate(-1);
    else navigate("/arm", { replace: true });
  }, [openedId, fromList, navigate]);
  const closePage = useCallback(() => {
    const call = callInterruptedBy(null);
    if (call) setSwitching({ call, go: leaveCard });
    else leaveCard();
  }, [leaveCard]);
  useEffect(() => {
    if (isList) return;
    // После справки фокус возвращается в общую шапку. Esc действует на всей
    // странице, но вложенные подсказки и телефон первыми обрабатывают событие.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closePage();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [isList, closePage]);
  useLayoutEffect(() => {
    if (!isList) {
      restoreList.current = true;
      window.scrollTo(0, 0);
      page.current?.focus({ preventScroll: true });
    }
  }, [isList, openedId]);

  const cards = useQuery({
    queryKey: ["cards"],
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
  // Занятия задают полосу вкладок и строку-правило над реестром.
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await api.GET("/sessions");
      return data ?? [];
    },
  });
  useLayoutEffect(() => {
    // После reload можно вернуться до ответа API: без строк браузер обрезает
    // прокрутку до нуля. Восстанавливаем один раз, когда список уже отрисован
    // вместе со всем, что стоит над ним (вкладки, правило параллельной работы).
    if (!isList || !cards.data || !sessions.data || !restoreList.current)
      return;
    restoreList.current = false;
    const saved = listPosition.current;
    if (table.current) {
      table.current.scrollLeft = saved.tableX;
      const row = [
        ...table.current.querySelectorAll<HTMLElement>("[data-card-id]"),
      ].find((el) => el.dataset.cardId === saved.cardId);
      row?.focus({ preventScroll: true });
    }
    window.scrollTo(saved.x, saved.y);
  }, [isList, cards.data, sessions.data]);
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data } = await api.GET("/services");
      return data ?? ([] as Service[]);
    },
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data } = await api.GET("/settings");
      return data ?? null;
    },
  });

  const normatives = settings.data ?? DEFAULT_SETTINGS;
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = newestFirst(cards.data ?? []);
    if (!query) return list;
    return list.filter((card) =>
      [
        card.source.number,
        card.source.incident_class,
        formatAddress(card.source.address),
        card.source.description,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [cards.data, search]);

  // Служба обучаемого задаётся занятием, поэтому у карточек разных занятий
  // она может отличаться: общую подпись показываем только для одного занятия.
  const sessionIds = [...new Set((cards.data ?? []).map((c) => c.session_id))];
  const context = useParticipant(
    sessionIds.length === 1 ? sessionIds[0] : null,
    user.id,
  );
  const ownService = services.data?.find(
    (service) => service.id === context.participant?.dds_service_id,
  );
  const ownServiceLabel =
    sessionIds.length > 1
      ? "зависит от занятия"
      : context.isPending
        ? "загружаем…"
        : (ownService?.name ??
          context.participant?.dds_service_id ??
          "занятие не начато");
  const opened = cards.data?.find((card) => card.id === openedId) ?? null;
  const helpEnabled = useHelpEnabled(opened?.session_id);
  const openedContext = useParticipant(opened?.session_id ?? null, user.id);
  const helpActions = useCardActions(
    opened?.id ?? "",
    Boolean(opened && !isClosed(opened) && openedContext.canAct),
  );
  useHelpGuide(
    helpEnabled && (!openedId || opened)
      ? openedId
        ? CARD_GUIDE
        : results
          ? RESULTS_GUIDE
          : reference
            ? REFERENCE_GUIDE
            : ARM_GUIDE
      : null,
    () => {
      if (opened && helpEnabled) void helpActions.hintOpen("help");
    },
  );
  useEffect(() => {
    document.title = opened
      ? `Происшествие ${opened.source.number}`
      : results
        ? "Мои результаты"
        : reference
          ? "Справка"
          : "Список происшествий";
    return () => {
      document.title = "Учебный тренажёр ДДС";
    };
  }, [opened, results, reference]);
  // Идущее занятие или тренировка: карточка вот-вот придёт, ждать осмысленно.
  const hasRunningSession = (sessions.data ?? []).some(
    (session) => session.status === "running",
  );
  // «Тренировка» запускает текущую ступень пути (первая — упражнение с
  // проводником); ключ общий с «Мой путь».
  const progress = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const { data, error } = await api.GET("/progress");
      if (!data) throw new Error(error?.message ?? "Путь недоступен.");
      return data[0] ?? null;
    },
  });
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isList) return;
    // «/» с любого места реестра — к поиску, как в почте и таблицах.
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const inInput = Boolean(
        target?.closest("input, textarea, select, [contenteditable='true']"),
      );
      if (listKey(event.key, inInput) === "focusSearch") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isList]);
  const active = (cards.data ?? []).filter(
    (card) => !isClosed(card) && !card.interrupted_at,
  ).length;

  return (
    <main
      ref={page}
      tabIndex={-1}
      className={openedId ? styles.cardPage : styles.arm}
    >
      <IncidentTabs
        cards={cards.data ?? []}
        openedId={openedId}
        listActive={isList}
        onList={() => (openedId ? closePage() : navigate("/arm"))}
        onOpen={openCard}
      />
      <ParallelNotice />
      {switching && (
        <SwitchCallDialog
          label={switching.call.label}
          onConfirm={async () => {
            const next = switching;
            setSwitching(null);
            await next.call.hangup();
            next.go();
          }}
          onCancel={() => setSwitching(null)}
        />
      )}
      <div className={styles.feedback}>
        <PendingActions />
      </div>
      <div hidden={!isList}>
        <section className={styles.search} data-help="arm-search">
          <h1>Поиск происшествий</h1>
          <input
            ref={searchInput}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (listKey(event.key, true) !== "firstRow") return;
              const first =
                table.current?.querySelector<HTMLElement>("[data-card-id]");
              if (!first) return;
              event.preventDefault();
              first.focus();
            }}
            placeholder="номер, тип, адрес или описание · / — поиск"
            aria-label="Поиск происшествий"
            className={styles.searchInput}
          />
          <button onClick={() => setSearch("")}>сбросить</button>
        </section>

        <section className={styles.list} data-help="arm-list">
          <div className={styles.listHead}>
            <h2>
              Список происшествий{" "}
              {/* Своя ДДС в интерфейсе нигде не подписана, а от неё зависит,
              по какой службе обучаемый ставит статус. */}
              <span className={styles.counter}>
                ваша служба: <strong>{ownServiceLabel}</strong> · в работе:{" "}
                {active} · всего: {cards.data?.length ?? 0}
              </span>
            </h2>
            {/* Кнопки — одной группой в порядке пути обучаемого: сначала
                потренироваться, затем посмотреть путь, проверить себя, итоги. */}
            <div className={styles.actions}>
              <PracticeButton
                step={trainingStep(progress.data)}
                label={trainingLabel(progress.data)}
              />
              <ProgressButton />
              <QuizButton />
              <button
                type="button"
                className={styles.resultsButton}
                onClick={() => navigate("/arm/results")}
              >
                Мои результаты
              </button>
              <button
                type="button"
                className={styles.resultsButton}
                onClick={() => navigate("/arm/reference")}
              >
                Справка
              </button>
            </div>
          </div>
          {cards.isError && (
            <p role="alert">
              Не удалось загрузить происшествия.{" "}
              <button
                disabled={cards.isFetching}
                onClick={() => void cards.refetch()}
              >
                Повторить
              </button>
            </p>
          )}
          <ParallelBanner />
          {cards.isPending && <p>Загрузка…</p>}
          <div className={styles.tableWrap} ref={table}>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((title) => (
                    <th
                      key={title}
                      className={
                        OPTIONAL_COLUMNS.includes(title)
                          ? styles.optional
                          : undefined
                      }
                    >
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Скрытые строки не должны загружать истории всех старых карточек.
                    Общий запрос cards остаётся активным и принимает новые выдачи. */}
                {isList &&
                  visible.map((card) => (
                    <IncidentRow
                      key={card.id}
                      card={card}
                      reactionNormativeS={normatives.reaction_normative_s}
                      now={now}
                      presented={isList}
                      onOpen={() => openCard(card.id)}
                    />
                  ))}
              </tbody>
            </table>
          </div>
          {cards.isSuccess && visible.length === 0 && (
            <p role="status">
              {emptyListText(
                search,
                hasRunningSession,
                trainingStep(progress.data),
              )}
            </p>
          )}
        </section>
      </div>

      {opened && (
        <IncidentCard
          key={opened.id}
          card={opened}
          services={services.data ?? []}
          handlingNormativeS={normatives.handling_normative_s}
          now={now}
          onClose={closePage}
          onReview={() => {
            setReviewId(opened.id);
            navigate("/arm/results");
          }}
        />
      )}
      {openedId && !opened && (
        <section className={styles.unavailable}>
          <p role={cards.isPending ? "status" : "alert"}>
            {cards.isPending
              ? "Загружаем карточку…"
              : cards.isError
                ? "Не удалось загрузить карточку. Проверьте соединение."
                : "Карточка не найдена или недоступна."}
          </p>
          {cards.isError && (
            <button onClick={() => void cards.refetch()}>Повторить</button>
          )}
          <button onClick={closePage}>К списку происшествий</button>
        </section>
      )}

      {reference && <ReferencePanel onClose={closePage} />}

      {results && (
        <ResultsPanel
          initialCardId={reviewId}
          services={services.data ?? []}
          onClose={closePage}
        />
      )}
    </main>
  );
}
