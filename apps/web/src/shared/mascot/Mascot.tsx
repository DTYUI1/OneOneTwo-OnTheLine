// Вид наставника: фигура по пояс в подсказке и окнах обучения, портрет — выключатель в шапке
// списка, «Без голоса» — в шапке подсказки. Позы — WebP с прозрачным фоном высотой 240 px
// (вдвое больше места на экране), обрезаны по пояс из набора библии (images/states/web/).
// Фигура — украшение: всё, что наставник говорит, написано рядом текстом, поэтому для
// чтения с экрана её нет.
import { useSyncExternalStore } from "react";
import approve from "./img/approve.webp";
import attention from "./img/attention.webp";
import correct from "./img/correct.webp";
import explain from "./img/explain.webp";
import goodbye from "./img/goodbye.webp";
import greet from "./img/greet.webp";
import listen from "./img/listen.webp";
import pointDown from "./img/point-down.webp";
import pointDownRight from "./img/point-down-right.webp";
import pointLeft from "./img/point-left.webp";
import pointRight from "./img/point-right.webp";
import pointUp from "./img/point-up.webp";
import pointUpRight from "./img/point-up-right.webp";
import portrait from "./img/portrait.webp";
import stepUp from "./img/step-up.webp";
import wait from "./img/wait.webp";
import {
  MASCOT_NAME,
  MASCOT_ROLE,
  mascotShown,
  mascotVoice,
  setMascotShown,
  setMascotVoice,
  subscribeMascot,
  type MascotPose,
} from "./mascotModel";
import { hush } from "./mentorVoice";
import styles from "./Mascot.module.css";

const POSES: Record<MascotPose, string> = {
  greet,
  "point-left": pointLeft,
  "point-right": pointRight,
  "point-up": pointUp,
  "point-down": pointDown,
  "point-up-right": pointUpRight,
  "point-down-right": pointDownRight,
  explain,
  wait,
  listen,
  correct,
  attention,
  approve,
  "step-up": stepUp,
  goodbye,
};

/** Портрет наставника — для кнопок вне подсказок («Пройти с наставником» в справке). */
export const MASCOT_PORTRAIT = portrait;

/** Показывать ли наставника — с перерисовкой, когда его включили или выключили. */
export function useMascotShown(): boolean {
  return useSyncExternalStore(subscribeMascot, mascotShown);
}

/** Говорит ли наставник вслух — с перерисовкой при смене. */
export function useMascotVoice(): boolean {
  return useSyncExternalStore(subscribeMascot, mascotVoice);
}

/** Фигура по пояс. Смена позы — плавное появление, без анимации при «уменьшить движение». */
export function MascotFigure({
  pose,
  className,
}: {
  readonly pose: MascotPose;
  readonly className?: string;
}) {
  return (
    <img
      key={pose}
      className={`${styles.figure} ${className ?? ""}`}
      src={POSES[pose]}
      alt=""
      aria-hidden="true"
      draggable={false}
      title={`${MASCOT_NAME}, ${MASCOT_ROLE}`}
      data-mascot={pose}
    />
  );
}

/** Портрет-выключатель: убрать наставника из подсказок или вернуть его. */
export function MascotToggle({ className }: { readonly className?: string }) {
  const shown = useMascotShown();
  return (
    <button
      type="button"
      className={`${styles.toggle} ${className ?? ""}`}
      aria-pressed={shown}
      aria-label={`${MASCOT_NAME} в подсказках`}
      title={
        shown
          ? `${MASCOT_NAME} подсказывает рядом с нужным местом. Нажмите, чтобы подсказки шли без него.`
          : "Подсказки идут без наставника. Нажмите, чтобы его вернуть."
      }
      onClick={() => {
        if (shown) hush();
        setMascotShown(!shown);
      }}
    >
      <img src={portrait} alt="" draggable={false} />
    </button>
  );
}

/**
 * Портрет наставника — кнопка «Тренировка с Николаем Сергеевичем» в шапке списка: открывает
 * выбор этапа на любой ступени (капитан, 20.10). Наставник выключен — портрет серый, включить
 * его можно в том же окне.
 */
export function MascotPortraitButton({
  className,
  onClick,
}: {
  readonly className?: string;
  readonly onClick: () => void;
}) {
  const shown = useMascotShown();
  return (
    <button
      type="button"
      className={`${styles.toggle} ${className ?? ""}`}
      data-off={shown ? undefined : ""}
      aria-label="Тренировка с Николаем Сергеевичем"
      title={
        shown
          ? "Тренировка с наставником: «Смотрю», «Вместе» или «Сам» — на учебной карточке."
          : "Тренировка с наставником. Сейчас подсказки идут без него — вернуть можно в этом окне."
      }
      onClick={onClick}
    >
      <img src={portrait} alt="" draggable={false} />
    </button>
  );
}

/** «Без голоса» — как «Без звука» у сигналов срочности: текст остаётся, наставник молчит. */
export function MascotVoiceSwitch({
  className,
}: {
  readonly className?: string;
}) {
  const voice = useMascotVoice();
  return (
    <label
      className={className}
      title="Наставник читает шаг вслух. Текст в подсказке остаётся и без голоса."
    >
      <input
        type="checkbox"
        checked={!voice}
        onChange={(event) => {
          if (event.target.checked) hush();
          setMascotVoice(!event.target.checked);
        }}
      />{" "}
      Без голоса
    </label>
  );
}
