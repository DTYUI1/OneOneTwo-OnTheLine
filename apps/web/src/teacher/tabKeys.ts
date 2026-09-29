// Вкладки с клавиатуры: ←/→ — соседняя вкладка, Home/End — первая и последняя.
// Вкладка переключается сразу (как по щелчку) и получает фокус.
import type { KeyboardEvent } from "react";

const STEP: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

export function onTabListKey(event: KeyboardEvent<HTMLElement>) {
  const step = STEP[event.key];
  if (!step) return;
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  const index = tabs.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  const next = tabs[step(index, tabs.length)];
  next.focus();
  next.click();
}
