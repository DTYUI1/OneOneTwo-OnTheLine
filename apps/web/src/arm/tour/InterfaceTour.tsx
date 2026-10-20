// Обучение по интерфейсу с наставником (tour.ts). При первом входе Николай Сергеевич
// спрашивает у своего портрета, хочет ли обучаемый пройти обучение, — подсказкой, а не окном:
// экран остаётся рабочим. Обучение — обход экрана: рамка вокруг части, подсказка рядом с ней
// (место — как у подсказки «Вместе», coach.ts: placeCoach), наставник указывает рукой на часть
// и говорит реплику. «Назад», «Далее», стрелки, Esc и ✕ — как у «Объяснения экрана»; щелчки
// мимо подсказки ничего не нажимают: экран только показывают.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  MascotFigure,
  MascotVoiceSwitch,
  useMascotShown,
} from "../../shared/mascot/Mascot";
import { poseToward, type MascotPose } from "../../shared/mascot/mascotModel";
import { hush, mentorText, say } from "../../shared/mascot/mentorVoice";
import { useSession } from "../../shared/session";
import {
  mentorAim,
  mentorOnRight,
  placeCoach,
  type Box,
  type CoachPlace,
} from "../trainer/coach";
import { introSeen } from "../trainer/stages";
import {
  findTarget,
  markTourOffered,
  OFFER_LINE,
  subscribeTour,
  tourOffered,
  tourRequests,
  visibleSteps,
  type TourStep,
} from "./tour";
import styles from "./Tour.module.css";

let spoken = 0;
const HEAD = "Обучение по интерфейсу";

/**
 * `offer` — экран может предложить обучение: список происшествий, обучаемый на первой
 * ступени. Предлагает один раз на пользователя и только с наставником; кто уже открывал
 * «Как устроено обучение», экран видел — ему не предлагает. Ушёл со списка, не ответив, —
 * предложение прячется до возвращения. В браузере под управлением программы (прогоны e2e,
 * снимки документации — navigator.webdriver) само не предлагает: там идут по экрану без
 * него. Повтор — из «?», он работает везде.
 */
export function InterfaceTour({ offer }: { readonly offer: boolean }) {
  const { user } = useSession();
  const mascot = useMascotShown();
  const requests = useSyncExternalStore(subscribeTour, tourRequests);
  const seen = useRef(requests);
  const [phase, setPhase] = useState<"offer" | "tour" | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (phase === "offer" && !offer) setPhase(null);
    if (
      offer &&
      mascot &&
      phase === null &&
      !navigator.webdriver &&
      !introSeen(user.id) &&
      !tourOffered(user.id)
    )
      setPhase("offer");
  }, [offer, mascot, phase, user.id]);
  useEffect(() => {
    if (requests <= seen.current) return;
    seen.current = requests;
    markTourOffered(user.id);
    setRun((value) => value + 1);
    setPhase("tour");
  }, [requests, user.id]);

  if (phase === "offer")
    return (
      <Offer
        onStart={() => {
          markTourOffered(user.id);
          setRun((value) => value + 1);
          setPhase("tour");
        }}
        onLater={() => {
          markTourOffered(user.id);
          setPhase(null);
        }}
      />
    );
  if (phase === "tour")
    return <Tour key={run} onClose={() => setPhase(null)} />;
  return null;
}

/**
 * «Хотите пройти интерактивное обучение по интерфейсу?» — без затемнения, у этапов обучения с
 * портретом наставника: у «?» в это время стоит одноразовая подсказка «Объяснение экрана».
 */
function Offer({
  onStart,
  onLater,
}: {
  readonly onStart: () => void;
  readonly onLater: () => void;
}) {
  useEffect(() => {
    spoken += 1;
    say(OFFER_LINE, `tour-offer:${spoken}`);
    return hush;
  }, []);
  return (
    <Bubble
      find={() =>
        findTarget(document, { help: "trainer-stages" }) ??
        findTarget(document, { trigger: true })
      }
      head={HEAD}
      pose="greet"
      onClose={onLater}
    >
      {/* Абзацы реплики разделены переводом строки в voice/lines.json. */}
      <div className={styles.speech}>
        {mentorText(OFFER_LINE)
          .split("\n")
          .map((text, index) => (
            <p key={text} className={index === 0 ? styles.lead : undefined}>
              {text}
            </p>
          ))}
      </div>
      <p className={styles.muted}>
        Позже — кнопка «?» вверху справа, затем «Пройти с наставником».
      </p>
      <div className={styles.btns}>
        <button type="button" className={styles.btn} onClick={onLater}>
          Не сейчас
        </button>
        <button type="button" className={styles.main} onClick={onStart}>
          Пройти обучение
        </button>
      </div>
    </Bubble>
  );
}

function Tour({ onClose }: { readonly onClose: () => void }) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const next = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = () => {
    hush();
    onClose();
  };

  // Шаги — по тому, что сейчас на экране (пустой список — без строки и предпросмотра).
  useEffect(() => setSteps(visibleSteps(document)), []);
  const step = steps?.[index] ?? null;
  const last = steps !== null && index === steps.length - 1;

  // Новый шаг: показать часть (прокрутить к ней), сказать реплику, фокус — на «Далее».
  useEffect(() => {
    if (!step) return;
    findTarget(document, step.target)?.scrollIntoView({ block: "nearest" });
    spoken += 1;
    say(step.line, `tour:${spoken}`);
    next.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => hush, []);
  // На экране нечего показывать — закрыться, а не висеть пустым.
  useEffect(() => {
    if (steps?.length === 0) close.current();
  }, [steps]);

  const go = useRef<(delta: number) => void>(() => {});
  go.current = (delta: number) => {
    if (!steps) return;
    const to = index + delta;
    if (to >= steps.length) close.current();
    else if (to >= 0) setIndex(to);
  };
  // Клавиши — раньше экрана: стрелки листают, Esc закрывает.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const delta =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (event.key === "Escape") close.current();
      else if (delta) go.current(delta);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!steps || !step) return null;
  return (
    <Bubble
      find={() => findTarget(document, step.target)}
      head={`Обучение · ${index + 1} из ${steps.length}`}
      pose={last ? "goodbye" : null}
      spotlight
      onClose={() => close.current()}
    >
      <p>{mentorText(step.line)}</p>
      <div className={styles.btns}>
        <button
          type="button"
          className={styles.btn}
          disabled={index === 0}
          onClick={() => go.current(-1)}
        >
          Назад
        </button>
        <button
          ref={next}
          type="button"
          className={styles.main}
          onClick={() => go.current(1)}
        >
          {last ? "Готово" : "Далее"}
        </button>
      </div>
    </Bubble>
  );
}

const boxOf = (el: Element): Box => {
  const rect = el.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

/** Рамка вокруг части чуть шире её самой. */
const FRAME_PAD = 4;

/**
 * Подсказка наставника у элемента: место — placeCoach, наставник у края, ближнего к
 * элементу, и указывает на него рукой (`pose` — другая поза). `spotlight` — рамка вокруг
 * элемента, остальное притушено, щелчки мимо подсказки ничего не нажимают.
 */
function Bubble({
  find,
  head,
  pose,
  spotlight = false,
  onClose,
  children,
}: {
  readonly find: () => HTMLElement | null;
  readonly head: string;
  readonly pose: MascotPose | null;
  readonly spotlight?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const [frame, setFrame] = useState<Box | null>(null);
  const [place, setPlace] = useState<CoachPlace | null>(null);
  const [right, setRight] = useState(false);
  const [pointing, setPointing] = useState<MascotPose>("point-down");

  // Место — по живой разметке: при прокрутке, смене размера и раз в 250 мс.
  const measure = useRef(() => {});
  measure.current = () => {
    const el = box.current;
    const target = find();
    if (!el || !target) return;
    const part = boxOf(target);
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const spot = {
      left: part.left - FRAME_PAD,
      top: part.top - FRAME_PAD,
      width: part.width + FRAME_PAD * 2,
      height: part.height + FRAME_PAD * 2,
    };
    const at = placeCoach(spot, size, {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    const onRight = mentorOnRight(at, size.width);
    const aim = mentorAim(at, size, part, onRight);
    setFrame((prev) => (sameBox(prev, spot) ? prev : spot));
    setPlace((prev) => (samePlace(prev, at) ? prev : at));
    setRight(onRight);
    setPointing(poseToward(aim.dx, aim.dy));
  };
  useLayoutEffect(() => measure.current());
  useEffect(() => {
    const run = () => measure.current();
    const timer = window.setInterval(run, 250);
    window.addEventListener("resize", run);
    window.addEventListener("scroll", run, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", run);
      window.removeEventListener("scroll", run, true);
    };
  }, []);

  return createPortal(
    <>
      {spotlight && <div className={styles.blocker} aria-hidden="true" />}
      {spotlight && frame && (
        <div
          className={styles.frame}
          aria-hidden="true"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
          }}
        />
      )}
      <section
        ref={box}
        className={styles.tour}
        role="dialog"
        aria-label={HEAD}
        data-placed={place !== null}
        data-side={place?.side ?? "below"}
        data-spotlight={spotlight}
        style={{
          left: place?.left ?? 0,
          top: place?.top ?? 0,
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        {/* Наставник без окна, текст — его «облако» речи с хвостиком к голове (19.10). */}
        <div className={styles.row} data-mentor-right={right}>
          <MascotFigure pose={pose ?? pointing} className={styles.mentor} />
          <div className={styles.cloud}>
            <div className={styles.head}>
              <span>{head}</span>
              <MascotVoiceSwitch className={styles.voice} />
              <button
                type="button"
                className={styles.close}
                aria-label="Закрыть обучение"
                title="Закрыть (Esc)"
                onClick={onClose}
              >
                ✕
              </button>
            </div>
            <div className={styles.body} aria-live="polite">
              {children}
            </div>
          </div>
        </div>
      </section>
    </>,
    document.body,
  );
}

function sameBox(a: Box | null, b: Box) {
  return (
    !!a &&
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function samePlace(a: CoachPlace | null, b: CoachPlace) {
  return (
    !!a &&
    a.side === b.side &&
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.arrow) === Math.round(b.arrow)
  );
}
