import { useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ConsoleView } from "./console/SessionList";
import { VIEW_KEY, readJSON, writeJSON } from "./persist";

/** История кабинета живёт в истории браузера и не выходит за его начальный вид. */
export function useViewHistory() {
  const location = useLocation();
  const navigate = useNavigate();
  const initial = useRef(readJSON<ConsoleView>(VIEW_KEY));
  const state = location.state as {
    teacherView?: ConsoleView;
    teacherIndex?: number;
  } | null;
  const index = state?.teacherIndex ?? 0;
  const end = useRef(index);
  const view = state?.teacherView ?? initial.current;
  // Сохраняем также переходы назад/вперёд: Firefox может убрать history.state
  // при reload, тогда восстановится именно текущий, а не последний открытый вид.
  useLayoutEffect(() => {
    if (view) writeJSON(VIEW_KEY, view);
  }, [view]);
  const open = (next: ConsoleView) => {
    end.current = index + 1;
    navigate("/teacher", {
      state: { teacherView: next, teacherIndex: index + 1 },
    });
    window.scrollTo(0, 0);
  };
  return {
    view,
    open,
    canBack: index > 0,
    canForward: index < end.current,
    back: () => navigate(-1),
    forward: () => navigate(1),
  };
}
