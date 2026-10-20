// Этапы обучения «Смотрю → Вместе → Сам» в шапке списка, рядом с «Тренировкой» (решение
// 17.10): панели тренажёра больше нет, а этап выбирать нужно и до первой карточки, и между
// ними. Кнопка запускает тренировку в режиме этапа (TrainerContext.startStage). Только пока
// обучаемый на ступени 1 — дальше обучение с нуля пройдено, тренировки — тесты.
//
// Портрет наставника рядом с группой — «Тренировка с Николаем Сергеевичем»: выбор этапа на
// любой ступени, там же — включить или убрать наставника из подсказок (библия маскота,
// раздел 8: свёрнутый — портрет в полосе тренировки; капитан, 20.10). Он не в группе этапов:
// группа видна только на ступени 1. Подсказки он не включает — их решает режим (coach.ts).
import { MascotPortraitButton } from "../../shared/mascot/Mascot";
import { STAGE_ORDER, STAGES } from "./stages";
import { useTrainer } from "./TrainerContext";
import styles from "./StageSwitch.module.css";

/** Портрет наставника в шапке списка — выбор этапа на любой ступени. */
export function MentorButton() {
  const trainer = useTrainer();
  if (!trainer) return null;
  return (
    <MascotPortraitButton
      className={styles.mentor}
      onClick={trainer.openMentor}
    />
  );
}

export function StageSwitch() {
  const trainer = useTrainer();
  if (!trainer) return null;
  const done = trainer.done();
  return (
    <>
      <span
        className={styles.stages}
        role="group"
        aria-label="Этапы обучения"
        data-help="trainer-stages"
      >
        {STAGE_ORDER.map((stage) => (
          <button
            key={stage}
            type="button"
            className={styles.stage}
            aria-current={trainer.mode === stage ? "step" : undefined}
            disabled={trainer.busy}
            title={
              trainer.blockedReason ||
              (trainer.busy
                ? "Тренировка запускается — подождите несколько секунд"
                : STAGES[stage].what)
            }
            onClick={() => trainer.startStage(stage)}
          >
            {done.has(stage) ? "✓ " : ""}
            {STAGES[stage].title}
          </button>
        ))}
      </span>
    </>
  );
}
