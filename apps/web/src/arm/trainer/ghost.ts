// Курсор тренажёра (макет B, из D): показ «Смотрю», «Покажи» и «Как сделал бы опытный».
// Поверх АРМ в обучении — только он и подсказка у элемента (TrainerCoach.tsx). Вид —
// `.ghost` в Trainer.module.css, стрелка — svg макета (`ghostEl`).
import styles from "./Trainer.module.css";

const ID = "trainer-ghost";

function ghostEl(): HTMLElement {
  let ghost = document.getElementById(ID);
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.id = ID;
    ghost.className = styles.ghost;
    ghost.setAttribute("aria-hidden", "true");
    ghost.innerHTML =
      '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 11-6.5 1.2L16.8 21l-3 1.4-3.6-6.9L5 19.6z" fill="#fff" stroke="#1c80c2" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    ghost.hidden = true;
    document.body.appendChild(ghost);
  }
  return ghost;
}

/**
 * Курсор — к элементу: к середине, но не дальше 48 × 24 px от левого верхнего угла.
 * Элемента уже нет на экране (React перерисовал строку статуса или окно телефона, пока
 * показ говорил) — курсор стоит, где был: у такого элемента координаты (0, 0), и курсор
 * уезжал в левый верхний угол (проверка капитана 18.10).
 */
export function ghostTo(el: Element): HTMLElement {
  const ghost = ghostEl();
  if (!el.isConnected || el.getClientRects().length === 0) return ghost;
  let box = el.getBoundingClientRect();
  if (box.top < 0 || box.bottom > innerHeight) {
    el.scrollIntoView({ block: "nearest" });
    box = el.getBoundingClientRect();
  }
  ghost.hidden = false;
  ghost.style.left = `${box.left + Math.min(box.width / 2, 48)}px`;
  ghost.style.top = `${box.top + Math.min(box.height / 2, 24)}px`;
  return ghost;
}

/** Кружок «нажатия» под курсором. */
export function ghostPress(on: boolean) {
  ghostEl().classList.toggle(styles.press, on);
}

export function hideGhost() {
  const ghost = document.getElementById(ID);
  if (ghost) ghost.hidden = true;
}

let pointTimer = 0;

/**
 * «Покажи»: курсор трижды показывает, куда нажать, но не нажимает за обучаемого
 * (`pointAt` макета).
 */
export function pointAt(el: Element) {
  ghostTo(el);
  window.clearTimeout(pointTimer);
  let taps = 0;
  const tap = () => {
    ghostPress(true);
    window.setTimeout(() => ghostPress(false), 220);
    taps += 1;
    pointTimer =
      taps < 3
        ? window.setTimeout(tap, 600)
        : window.setTimeout(hideGhost, 900);
  };
  pointTimer = window.setTimeout(tap, 650);
}
