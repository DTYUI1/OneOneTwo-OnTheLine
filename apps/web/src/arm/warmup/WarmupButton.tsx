// Кнопка «Разминка» и окно упражнений (DT-09): «Найди отличие в адресе» и «Кого
// направить». Результат — на сервер (POST /warmups), в оценку занятий он не идёт:
// это тренировка навыка в своём темпе. Ошибки прошлой разминки идут первыми.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { Dialog } from "../Dialog";
import {
  ADDRESS_PAIRS,
  bestResult,
  lastMistakes,
  mistakeText,
  pairId,
  ROUTING,
  routingCorrect,
  routingMistake,
  scoreText,
  withMissedFirst,
  type AddressPair,
  type RoutingItem,
  type SavedResult,
  type WarmupKind,
} from "./warmupModel";
import arm from "../ArmPage.module.css";
import quiz from "../quiz/Quiz.module.css";
import styles from "./Warmup.module.css";

const PAIRS_PER_RUN = 10;

interface Finished {
  readonly kind: WarmupKind;
  readonly correct: number;
  readonly total: number;
  readonly duration_ms: number;
  readonly mistakes: readonly string[];
}

export function WarmupButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={arm.resultsButton}
        data-help="tool-warmup"
        onClick={() => setOpen(true)}
        title="Короткие упражнения на один навык: адрес и кого направить"
      >
        Разминка
      </button>
      {open && <WarmupDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function WarmupDialog({ onClose }: { onClose: () => void }) {
  const queries = useQueryClient();
  const results = useQuery({
    queryKey: ["warmups"],
    queryFn: async (): Promise<SavedResult[]> => {
      const { data } = await api.GET("/warmups");
      return data ?? [];
    },
  });
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => (await api.GET("/services")).data ?? [],
  });
  const [mode, setMode] = useState<WarmupKind | null>(null);
  const [run, setRun] = useState(0);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const saved = results.data ?? [];

  async function save(result: Finished) {
    setSaving("saving");
    const { error } = await api.POST("/warmups", {
      params: { header: { "X-CSRF-Token": csrfToken() } },
      body: { ...result, mistakes: [...result.mistakes] },
    });
    if (error) {
      setSaving("error");
      return;
    }
    setSaving("saved");
    void queries.invalidateQueries({ queryKey: ["warmups"] });
  }

  function finish(result: Finished) {
    setFinished(result);
    void save(result);
  }

  function start(kind: WarmupKind) {
    setMode(kind);
    setFinished(null);
    setSaving("idle");
    setRun((value) => value + 1);
  }

  const serviceName = (id: string) =>
    services.data?.find((service) => service.id === id)?.name ?? id;

  return (
    <div className={quiz.backdrop}>
      <Dialog label="Разминка" className={quiz.dialog} onClose={onClose}>
        <h2>Разминка</h2>
        {mode === null && (
          <div className={styles.menu}>
            <p className={styles.lead}>
              Две минуты на один навык, в своём темпе. Ошибки вернутся первыми в
              следующий раз.
            </p>
            <Choice
              title="Найди отличие в адресе"
              text="Две записи адреса: одинаковые или нет? Клавиши ← и → тоже работают."
              best={bestResult(saved, "address")}
              onStart={() => start("address")}
            />
            <Choice
              title="Кого направить"
              text="Описание происшествия — отметьте службы, которые нужны."
              best={bestResult(saved, "routing")}
              onStart={() => start("routing")}
            />
          </div>
        )}
        {mode !== null && finished && (
          <Result
            result={finished}
            serviceName={serviceName}
            saving={saving}
            onRetrySave={() => void save(finished)}
            onAgain={() => start(mode)}
            onMenu={() => setMode(null)}
          />
        )}
        {mode === "address" && !finished && (
          <AddressDrill
            key={run}
            missed={lastMistakes(saved, "address")}
            onFinish={finish}
          />
        )}
        {mode === "routing" && !finished && (
          <RoutingDrill
            key={run}
            missed={lastMistakes(saved, "routing")}
            serviceName={serviceName}
            onFinish={finish}
          />
        )}
        <div className={quiz.actions}>
          {mode !== null && !finished && (
            <button type="button" onClick={() => setMode(null)}>
              К разминке
            </button>
          )}
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </Dialog>
    </div>
  );
}

function Choice({
  title,
  text,
  best,
  onStart,
}: {
  title: string;
  text: string;
  best: SavedResult | null;
  onStart: () => void;
}) {
  return (
    <section className={styles.choice} aria-label={title}>
      <h3>{title}</h3>
      <p>{text}</p>
      <p className={styles.muted}>
        {best ? `Ваш лучший: ${scoreText(best)}.` : "Ещё не проходили."}
      </p>
      <button type="button" className={quiz.primary} onClick={onStart}>
        Начать
      </button>
    </section>
  );
}

function Result({
  result,
  serviceName,
  saving,
  onRetrySave,
  onAgain,
  onMenu,
}: {
  result: Finished;
  serviceName: (id: string) => string;
  saving: "idle" | "saving" | "saved" | "error";
  onRetrySave: () => void;
  onAgain: () => void;
  onMenu: () => void;
}) {
  return (
    <div className={styles.result}>
      <p className={styles.score} role="status">
        {scoreText(result)}
      </p>
      <p className={styles.muted}>
        {saving === "saving" && "Сохраняем результат…"}
        {saving === "saved" && "Результат сохранён."}
        {saving === "error" && (
          <>
            Не удалось сохранить результат.{" "}
            <button type="button" onClick={onRetrySave}>
              Сохранить ещё раз
            </button>
          </>
        )}
      </p>
      {result.mistakes.length > 0 ? (
        <>
          <h3>Вернутся первыми в следующий раз</h3>
          <ul className={styles.mistakes}>
            {result.mistakes.map((mistake) => (
              <li key={mistake}>{mistakeText(mistake, serviceName)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>Ошибок нет.</p>
      )}
      <div className={styles.row}>
        <button type="button" className={quiz.primary} onClick={onAgain}>
          Ещё раз
        </button>
        <button type="button" onClick={onMenu}>
          К разминке
        </button>
      </div>
    </div>
  );
}

/** Общая часть строк: где записи расходятся — подсвечиваем после ответа. */
function marked(a: string, b: string): [ReactNode, ReactNode] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end += 1;
  const part = (text: string) => (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, text.length - end)}</mark>
      {text.slice(text.length - end)}
    </>
  );
  return [part(a), part(b)];
}

function AddressDrill({
  missed,
  onFinish,
}: {
  missed: readonly string[];
  onFinish: (result: Finished) => void;
}) {
  const [pairs] = useState<AddressPair[]>(() =>
    withMissedFirst(ADDRESS_PAIRS, pairId, missed).slice(0, PAIRS_PER_RUN),
  );
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [shown, setShown] = useState<boolean | null>(null);
  const started = useRef(Date.now());
  const pair = pairs[index];

  function answer(same: boolean) {
    if (shown !== null || !pair) return;
    const ok = same === pair.same;
    const next = [...answers, ok];
    setAnswers(next);
    setShown(ok);
    window.setTimeout(
      () => {
        setShown(null);
        if (index + 1 < pairs.length) setIndex(index + 1);
        else
          onFinish({
            kind: "address",
            correct: next.filter(Boolean).length,
            total: pairs.length,
            duration_ms: Date.now() - started.current,
            mistakes: pairs.filter((_, at) => !next[at]).map(pairId),
          });
      },
      ok ? 700 : 1800,
    );
  }

  // Стрелки — для тех, кому удобнее клавиатура: ← одинаковые, → разные.
  const answerRef = useRef(answer);
  answerRef.current = answer;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") answerRef.current(true);
      if (event.key === "ArrowRight") answerRef.current(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!pair) return null;
  const [a, b] =
    shown === false && !pair.same ? marked(pair.a, pair.b) : [pair.a, pair.b];
  return (
    <section className={styles.drill} aria-label="Найди отличие в адресе">
      <p className={styles.muted}>
        {index + 1} из {pairs.length}
      </p>
      <div className={styles.pair}>
        <p>{a}</p>
        <p>{b}</p>
      </div>
      {shown === null ? (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.big}
            onClick={() => answer(true)}
          >
            Одинаковые ←
          </button>
          <button
            type="button"
            className={styles.big}
            onClick={() => answer(false)}
          >
            Разные →
          </button>
        </div>
      ) : (
        <p className={shown ? styles.good : styles.bad} role="status">
          {shown ? "Верно." : "Неверно."}{" "}
          {pair.same ? "Записи одинаковые." : pair.note}
        </p>
      )}
    </section>
  );
}

function RoutingDrill({
  missed,
  serviceName,
  onFinish,
}: {
  missed: readonly string[];
  serviceName: (id: string) => string;
  onFinish: (result: Finished) => void;
}) {
  const [items] = useState<RoutingItem[]>(() =>
    withMissedFirst(ROUTING, (item) => item.key, missed),
  );
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [right, setRight] = useState<boolean[]>([]);
  const started = useRef(Date.now());
  const item = items[index];
  // Выбор — из всех служб тренировки, а не только нужных: иначе ответ виден заранее.
  const choices = [...new Set(ROUTING.flatMap((one) => one.services))].sort();
  if (!item) return null;
  const ok = routingCorrect(item, picked);

  function next() {
    const all = [...right, ok];
    setRight(all);
    if (index + 1 < items.length) {
      setIndex(index + 1);
      setPicked([]);
      setChecked(false);
      return;
    }
    onFinish({
      kind: "routing",
      correct: all.filter(Boolean).length,
      total: items.length,
      duration_ms: Date.now() - started.current,
      mistakes: items.filter((_, at) => !all[at]).map(routingMistake),
    });
  }

  return (
    <section className={styles.drill} aria-label="Кого направить">
      <p className={styles.muted}>
        {index + 1} из {items.length}
      </p>
      <p className={styles.incident}>{item.text}</p>
      <div className={styles.row} role="group" aria-label="Службы">
        {choices.map((id) => {
          const on = picked.includes(id);
          // После проверки цвет говорит о верности, а не о выборе: нужные — зелёные,
          // лишние отмеченные — красные.
          const mark = checked
            ? item.services.includes(id)
              ? styles.need
              : on
                ? styles.extra
                : ""
            : on
              ? styles.on
              : "";
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              disabled={checked}
              className={`${styles.service} ${mark}`}
              onClick={() =>
                setPicked(
                  on ? picked.filter((value) => value !== id) : [...picked, id],
                )
              }
            >
              {serviceName(id)}
            </button>
          );
        })}
      </div>
      {checked ? (
        <>
          <p className={ok ? styles.good : styles.bad} role="status">
            {ok
              ? "Верно."
              : `Нужно: ${item.services.map(serviceName).join(", ")}.`}
          </p>
          <button type="button" className={quiz.primary} onClick={next}>
            {index + 1 < items.length ? "Дальше" : "Итог"}
          </button>
        </>
      ) : (
        <button
          type="button"
          className={quiz.primary}
          disabled={picked.length === 0}
          onClick={() => setChecked(true)}
        >
          Проверить
        </button>
      )}
    </section>
  );
}
