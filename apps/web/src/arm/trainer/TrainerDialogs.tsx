// Окна обучения (макет B, `modalView`): «Как устроено обучение» перед первым звонком
// тренировки и «Этап пройден». Вид — окна АРМ (Trainer.module.css, 17.10). Наставник
// Николай Сергеевич здоровается в первом окне, одобряет «Смотрю» и хвалит за «Вместе» — и
// говорит это вслух (shared/mascot/; тексты — его реплики voice/lines.json); выключен — окна
// прежние. В окнах «Этап пройден» кнопки этапов сказаны словами — что будет, а не «2. Вместе»,
// и есть «В главное меню» — к списку происшествий (капитан, 20.10). Портрет наставника в
// шапке списка открывает «Тренировку с Николаем Сергеевичем» — выбор этапа на любой ступени:
// все три этапа — учебная карточка ступени 1, и здесь же сказано, когда ступень 1 зачтётся.
import { useEffect, type ReactNode } from "react";
import { MascotFigure, useMascotShown } from "../../shared/mascot/Mascot";
import {
  setMascotShown,
  type MascotPose,
} from "../../shared/mascot/mascotModel";
import { hush, mentorText, say } from "../../shared/mascot/mentorVoice";
import { Dialog } from "../Dialog";
import {
  conventions,
  nextStage,
  STAGE_ORDER,
  STAGES,
  stepOneNote,
  type Stage,
} from "./stages";
import { useTrainer, type TrainerDialog } from "./TrainerContext";
import styles from "./Trainer.module.css";

/**
 * Реплика наставника окна (voice/lines.json): текст на экране и запись. У выбора этапа её нет:
 * его открывают часто, приветствие каждый раз было бы лишним.
 */
const LINES = {
  intro: "greet",
  watchDone: "watch-done",
  togetherDone: "together-done",
} as const;
const DIALOG_LINES: Partial<Record<TrainerDialog["kind"], string>> = LINES;
let opened = 0;

const plural = (n: number) => {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return "раз";
  return ones >= 2 && ones <= 4 ? "раза" : "раз";
};

export function TrainerDialogs({
  service,
  workstation,
  reactionS,
  pathStep,
  onReview,
  onMenu,
}: {
  /** «Служба 101 — Пожарная охрана», если занятие известно. */
  readonly service: string | null;
  readonly workstation: number | null;
  readonly reactionS: number;
  /** Текущая ступень «Моего пути»; на первой — нет: зачтётся ли ступень 1. */
  readonly pathStep: number | undefined;
  readonly onReview: (cardId: string) => void;
  /** «В главное меню»: список происшествий — «Тренировка», «Мой путь», этапы. */
  readonly onMenu: () => void;
}) {
  const trainer = useTrainer();
  const mascot = useMascotShown();
  const dialog = trainer?.dialog;
  // Окно открылось — наставник говорит его реплику; закрыли — замолкает.
  useEffect(() => {
    const line = dialog ? DIALOG_LINES[dialog.kind] : undefined;
    if (!line || !mascot) return;
    opened += 1;
    say(line, `dialog:${opened}`);
    return hush;
  }, [dialog, mascot]);
  if (!trainer || !dialog) return null;
  const stageButton = (
    stage: Stage,
    className: string,
    label: string,
    /** Подсказка при наведении: какой это этап. */
    hint?: string,
  ) => (
    <button
      key={stage}
      type="button"
      className={className}
      disabled={trainer.busy}
      title={
        trainer.busy
          ? "Тренировка запускается — подождите несколько секунд"
          : hint
      }
      onClick={() => trainer.startStage(stage)}
    >
      {label}
    </button>
  );
  const menuButton = (
    <button
      type="button"
      className={`${styles.btn} ${styles.leave}`}
      title="Список происшествий: «Тренировка», «Мой путь», этапы обучения"
      onClick={() => {
        trainer.closeDialog();
        onMenu();
      }}
    >
      В главное меню
    </button>
  );

  let head = "";
  let body: ReactNode = null;
  let actions: ReactNode = null;
  if (dialog.kind === "intro") {
    const done = trainer.done();
    const next = nextStage(done);
    head = "Как устроено обучение";
    body = (
      <>
        {mascot && <Say pose="greet">{mentorText(LINES.intro)}</Say>}
        <p>
          {service
            ? `${service}${workstation ? `, АРМ ${workstation}` : ""}. `
            : ""}
          Перед вами АРМ-112, как на рабочем месте, и телефон службы.
          {!mascot &&
            " В «Смотрю» и «Вместе» тренажёр подсказывает рядом с нужным местом, в «Сам» молчит."}
        </p>
        <h4>Что здесь условно</h4>
        <ul className={styles.conv}>
          {conventions(reactionS).map((item) => (
            <li key={item.head}>
              <b>{item.head}</b> {item.text}
            </li>
          ))}
        </ul>
        <h4>Три этапа</h4>
        <div className={styles.steps}>
          {STAGE_ORDER.map((stage) => (
            <div
              key={stage}
              className={`${styles.step} ${done.has(stage) ? styles.done : ""}`}
            >
              <b>
                {STAGES[stage].n}. {STAGES[stage].title}
              </b>
              <p>{STAGES[stage].what}</p>
            </div>
          ))}
        </div>
        <p className={styles.muted}>
          Лучше в наушниках: бригада говорит голосом, субтитры есть всегда.
        </p>
      </>
    );
    // Этап можно открыть и не по порядку — чтобы не проходить всё ради одного места.
    // Кнопки идут по порядку этапов, следующий — синий (стенд 18.10: «Начать: 1. Смотрю»
    // в конце ряда читалось как бред).
    actions = (
      <>
        {STAGE_ORDER.map((stage) =>
          stageButton(
            stage,
            stage === next ? styles.big : styles.btn,
            `${STAGES[stage].n}. ${STAGES[stage].title}`,
          ),
        )}
      </>
    );
  }
  if (dialog.kind === "mentor") {
    const done = trainer.done();
    const next = nextStage(done);
    head = "Тренировка с Николаем Сергеевичем";
    body = (
      <>
        <Say pose="greet" shown={mascot}>
          Пройдём учебную карточку. Выберите, как: посмотреть, пройти со мной
          или самому.
        </Say>
        <div className={styles.steps}>
          {STAGE_ORDER.map((stage) => (
            <button
              key={stage}
              type="button"
              className={`${styles.step} ${styles.choice} ${done.has(stage) ? styles.done : ""}`}
              aria-current={stage === next ? "step" : undefined}
              disabled={trainer.busy || Boolean(trainer.blockedReason)}
              title={
                trainer.busy
                  ? "Тренировка запускается — подождите несколько секунд"
                  : trainer.blockedReason || undefined
              }
              onClick={() => trainer.startStage(stage)}
            >
              <b>
                {done.has(stage) ? "✓ " : ""}
                {STAGES[stage].n}. {STAGES[stage].title}
              </b>
              <span>{STAGES[stage].what}</span>
            </button>
          ))}
        </div>
        <p>{stepOneNote(pathStep)}</p>
        {trainer.blockedReason && <p role="status">{trainer.blockedReason}</p>}
        <label className={styles.muted}>
          <input
            type="checkbox"
            checked={mascot}
            onChange={(event) => {
              if (!event.target.checked) hush();
              setMascotShown(event.target.checked);
            }}
          />{" "}
          Николай Сергеевич в подсказках (фигура и голос)
        </label>
      </>
    );
    actions = (
      <button
        type="button"
        className={styles.btn}
        onClick={trainer.closeDialog}
      >
        Закрыть
      </button>
    );
  }
  if (dialog.kind === "watchDone") {
    head = "Этап «Смотрю» пройден";
    body = (
      <>
        <Say pose="approve" shown={mascot}>
          {mentorText(LINES.watchDone)}
        </Say>
        <ul>
          <li>
            «Принята» — за {reactionS} секунд: сначала решение, потом всё
            остальное.
          </li>
          <li>Адрес читаю в карточке и слушаю, как бригада его повторила.</li>
          <li>
            Бригаде отвечаю сразу: она звонит не просто так — этаж, скорая,
            новое.
          </li>
          <li>
            Звоню по порядку памятки: кто я, адрес и повод, карточка, что
            изменилось.
          </li>
          <li>
            Статус — по докладу бригады. Номер наряда остаётся в строке, Enter
            сохраняет.
          </li>
        </ul>
        <p>Дальше та же карточка, но нажимаете вы.</p>
        <p className={styles.muted}>{stepOneNote(pathStep)}</p>
      </>
    );
    actions = (
      <>
        {menuButton}
        {stageButton("watch", styles.btn, "Посмотреть ещё раз")}
        {stageButton(
          "together",
          styles.big,
          "Пройти карточку с подсказками",
          "Этап 2 «Вместе»: нажимаете вы, наставник подсказывает рядом с нужным местом",
        )}
      </>
    );
  }
  if (dialog.kind === "togetherDone") {
    const helps = dialog.helps;
    head = "Этап «Вместе» пройден";
    body = (
      <>
        <Say pose="step-up" shown={mascot}>
          {mentorText(LINES.togetherDone)}
        </Say>
        <p>
          {helps
            ? `Помощь понадобилась ${helps} ${plural(helps)}: «Покажи» или подсказка — всё в разборе.`
            : "Помощь не понадобилась."}
        </p>
        <p className={styles.muted}>
          Дальше — обычная тренировка. Мир больше не ждёт: бригада едет и звонит
          сама.
        </p>
        <p className={styles.muted}>{stepOneNote(pathStep)}</p>
      </>
    );
    actions = (
      <>
        {menuButton}
        <button
          type="button"
          className={styles.btn}
          onClick={() => {
            trainer.closeDialog();
            onReview(dialog.cardId);
          }}
        >
          Разбор
        </button>
        {stageButton(
          "together",
          styles.btn,
          "Ещё раз с подсказками",
          "Этап 2 «Вместе» ещё раз",
        )}
        {stageButton(
          "solo",
          styles.big,
          "Пройти без подсказок",
          "Этап 3 «Сам»: та же учебная карточка без подсказок — как на занятии",
        )}
      </>
    );
  }
  return (
    <div className={styles.back}>
      <Dialog
        label={head}
        className={styles.modal}
        onClose={trainer.closeDialog}
      >
        <h2>{head}</h2>
        <div>{body}</div>
        <div className={styles.actions}>{actions}</div>
      </Dialog>
    </div>
  );
}

/**
 * Слова наставника: фигура по пояс и абзац рядом, под ними — черта, на которой он стоит.
 * Наставник выключен — обычный абзац окна.
 */
function Say({
  pose,
  shown = true,
  children,
}: {
  readonly pose: MascotPose;
  readonly shown?: boolean;
  readonly children: ReactNode;
}) {
  if (!shown) return <p>{children}</p>;
  return (
    <div className={styles.mentor}>
      <MascotFigure pose={pose} />
      <p>{children}</p>
    </div>
  );
}
