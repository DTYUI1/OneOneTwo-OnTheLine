import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./Dialog";
import { ReferencePanel } from "./ReferencePanel";
import {
  addedReferences,
  lessonFiles,
  type LessonMaterials,
} from "./referenceModel";
import {
  useReferenceMaterials,
  useReferenceUpdates,
} from "./useReferenceMaterials";
import styles from "./ReferencePanel.module.css";

/** Панель — сосед карточки: открытие не меняет маршрут и не размонтирует её форму. */
export function ReferenceAccess({
  sessionId,
  running,
}: {
  sessionId?: string;
  running: boolean;
}) {
  const materials = useReferenceMaterials();
  useReferenceUpdates();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const previous = useRef<LessonMaterials[]>();
  useEffect(() => {
    if (!materials.data) return;
    const added = addedReferences(previous.current, materials.data);
    previous.current = materials.data;
    if (added.length)
      setNotice(
        `Преподаватель добавил материал: ${added.map((item) => item.title).join(", ")}`,
      );
  }, [materials.data]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  const current = (materials.data ?? []).filter(
    (lesson) =>
      lesson.is_current && (!sessionId || lesson.session_id === sessionId),
  );
  const count = current.reduce(
    (sum, lesson) => sum + lessonFiles(lesson).length,
    0,
  );
  return (
    <>
      {running && (
        <div className={styles.access}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={open}
          >
            Справка ({count})
          </button>
          <span role="status" className={styles.notice}>
            {notice}
          </span>
        </div>
      )}
      {open &&
        createPortal(
          <div
            className={styles.overlay}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Dialog
              label="Справка к занятию"
              className={styles.drawer}
              onClose={() => setOpen(false)}
            >
              <ReferencePanel
                sessionId={sessionId}
                side
                onClose={() => setOpen(false)}
              />
            </Dialog>
          </div>,
          document.body,
        )}
    </>
  );
}
