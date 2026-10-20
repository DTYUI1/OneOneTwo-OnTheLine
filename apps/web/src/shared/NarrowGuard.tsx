// Узкий экран (TC-14): рабочее место обучаемого рассчитано на большой экран. На узком
// сначала объясняем это, «Открыть всё равно» пускает дальше до конца вкладки.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import styles from "./NarrowGuard.module.css";

/** Уже этого АРМ не помещается: список, карточка и связь рядом. */
export const NARROW_PX = 900;
const OPEN_KEY = "narrow:open";

function subscribe(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}
const narrow = () => window.innerWidth < NARROW_PX;

function openedBefore(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function NarrowGuard({ children }: { children: ReactNode }) {
  const small = useSyncExternalStore(subscribe, narrow);
  const [opened, setOpened] = useState(openedBefore);
  if (!small || opened) return <>{children}</>;
  return (
    <main className={styles.guard} data-narrow-guard="">
      <h1>Рабочее место — для большого экрана</h1>
      <p>
        Откройте его на компьютере: на узком экране список происшествий и
        карточка не помещаются рядом.
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            sessionStorage.setItem(OPEN_KEY, "1");
          } catch {
            // Без хранилища окно спросит снова после перезагрузки — не страшно.
          }
          setOpened(true);
        }}
      >
        Открыть всё равно
      </button>
    </main>
  );
}
