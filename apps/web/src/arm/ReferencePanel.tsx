// Материалы сгруппированы сервером по занятиям; версии разных занятий не смешиваются.
import {
  contentUrl,
  formatSize,
  MEDIA_TYPES,
} from "../teacher/materials/materialsModel";
import { WorkflowSteps } from "../shared/WorkflowGuide";
import { lessonFiles, type LessonMaterials } from "./referenceModel";
import { useReferenceMaterials } from "./useReferenceMaterials";
import styles from "./results/Results.module.css";
import reference from "./ReferencePanel.module.css";

function LessonFiles({ lesson }: { lesson: LessonMaterials }) {
  const files = lessonFiles(lesson);
  return (
    <div className={reference.lesson}>
      <h3>{lesson.title}</h3>
      <p className={styles.muted}>
        {lesson.date
          ? new Date(lesson.date).toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })
          : "Дата занятия не указана"}
      </p>
      {files.length === 0 ? (
        <p>Преподаватель пока не прикрепил материалы к этому занятию.</p>
      ) : (
        <ul className={styles.referenceList} data-help="reference-materials">
          {files.map((item) => (
            <li key={`${item.id}:${item.version}`}>
              <a href={contentUrl(item)} target="_blank" rel="noreferrer">
                {item.title}
              </a>
              <span className={styles.muted}>
                {MEDIA_TYPES[item.media_type]?.label ?? item.media_type} ·{" "}
                {formatSize(item.size_bytes)} · версия {item.version}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReferencePanel({
  onClose,
  sessionId,
  side = false,
}: {
  onClose: () => void;
  sessionId?: string;
  side?: boolean;
}) {
  const materials = useReferenceMaterials();
  const current = (materials.data ?? []).filter(
    (lesson) =>
      lesson.is_current && (!sessionId || lesson.session_id === sessionId),
  );
  const past = (materials.data ?? []).filter(
    (lesson) => !lesson.is_current && lesson.materials.length > 0,
  );
  return (
    <section
      className={side ? reference.content : styles.panel}
      aria-labelledby="reference-title"
    >
      <header className={styles.head} data-help="reference-heading">
        <h2 id="reference-title">Справка</h2>
        <button
          type="button"
          className={`${styles.close} ${reference.close}`}
          onClick={onClose}
          aria-label="Закрыть справку"
        >
          ✕
        </button>
      </header>
      {materials.isPending && (
        <p className={styles.empty}>Загружаем справку…</p>
      )}
      {materials.isError && (
        <p role="alert" className={styles.empty}>
          {materials.error.message}{" "}
          <button onClick={() => void materials.refetch()}>Повторить</button>
        </p>
      )}
      {materials.data && (
        <div className={reference.body}>
          <h2>К этому занятию</h2>
          {current.length ? (
            current.map((lesson) => (
              <LessonFiles key={lesson.session_id} lesson={lesson} />
            ))
          ) : (
            <p>Сейчас у вас нет идущего занятия.</p>
          )}
          <details className={reference.past}>
            <summary>С прошлых занятий ({past.length})</summary>
            {past.length ? (
              past.map((lesson) => (
                <LessonFiles key={lesson.session_id} lesson={lesson} />
              ))
            ) : (
              <p>Материалов с прошлых занятий пока нет.</p>
            )}
          </details>
          <details className={reference.past}>
            <summary>Общий порядок работы</summary>
            <p>Это памятка по интерфейсу, а не решение текущего задания.</p>
            <WorkflowSteps />
          </details>
        </div>
      )}
    </section>
  );
}
