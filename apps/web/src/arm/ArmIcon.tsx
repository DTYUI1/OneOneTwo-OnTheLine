// Значки АРМ-112 — простые контуры по скриншотам arm_dds, перенесены из макета B
// (prototype-b/app.js, ICON). Значок только рисует: действия у него нет, подпись
// для экранного диктора даёт кнопка, в которой он стоит.
import styles from "./ArmIcon.module.css";

const PATHS = {
  hang: (
    <path
      d="M3 14c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2.5c-2.3-.7-4.7-.7-7 0V15l-3 1.5z"
      fill="currentColor"
    />
  ),
  phone: (
    <path
      d="M6.6 3.5l3 3-1.8 2.3c1.2 2.5 3 4.3 5.5 5.5l2.3-1.8 3 3-2 2.5C10 17.6 6.4 14 4.1 5.5z"
      fill="currentColor"
    />
  ),
  sms: (
    <>
      <path d="M4 5h16v11H9l-5 4z" fill="currentColor" />
      <path d="M8 10h1M12 10h1M16 10h1" stroke="#efefef" strokeWidth="2" />
    </>
  ),
  pinOff: (
    <>
      <path
        d="M12 3a6 6 0 0 1 6 6c0 4-6 12-6 12S6 13 6 9a6 6 0 0 1 6-6z"
        fill="currentColor"
      />
      <path d="M4 4l16 16" stroke="#efefef" strokeWidth="3" />
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  bolt: <path d="M13 2L5 14h6l-1 8 8-12h-6z" fill="currentColor" />,
  warn: (
    <>
      <path d="M12 3l10 18H2z" fill="currentColor" />
      <path d="M12 9v6M12 17v2" stroke="#e9663c" strokeWidth="2.2" />
    </>
  ),
  pen: <path d="M4 20l1-4L16 5l3 3L8 19z" fill="currentColor" />,
  book: <path d="M7 3h10v18l-5-4-5 4z" fill="currentColor" />,
  link: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M10 14l4-4M8 15l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16 9l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" />
    </g>
  ),
  flash: (
    <path
      d="M14 3L6 13h5l-2 8 9-11h-5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    />
  ),
  timer: (
    <>
      <circle
        cx="12"
        cy="13"
        r="7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M12 13V9M10 3h4" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  shieldOff: (
    <>
      <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" fill="currentColor" />
      <path d="M4 4l16 16" stroke="#2f353a" strokeWidth="3" />
    </>
  ),
  clip: (
    <>
      <path d="M6 5h3a3 3 0 0 1 6 0h3v16H6z" fill="currentColor" />
      <path d="M9 11h6M9 15h6" stroke="#2f353a" strokeWidth="1.6" />
    </>
  ),
  lens: (
    <>
      <circle
        cx="14"
        cy="10"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <path d="M10 14l-7 7" stroke="currentColor" strokeWidth="3" />
    </>
  ),
  expand: (
    <path
      d="M7 9l5-5 5 5M7 15l5 5 5-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
  ),
  note: (
    <>
      <path d="M4 4h16v12H9l-5 4z" fill="currentColor" />
      <path d="M12 7v5M12 13.5v1.5" stroke="#49555d" strokeWidth="2" />
    </>
  ),
  close: (
    <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="2.2" />
  ),
  check: (
    <path
      d="M5 12l5 5 9-10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
  ),
  up: (
    <path d="M7 14l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2" />
  ),
  down: (
    <path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" />
  ),
  // Стрелки пагинации реестра (arm_dds/02, 03) — крупнее и толще стрелок строк.
  left: (
    <path
      d="M15 5l-7 7 7 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
    />
  ),
  right: (
    <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="3" />
  ),
  gear: (
    <circle
      cx="12"
      cy="12"
      r="5"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeDasharray="3 2"
    />
  ),
  monitor: (
    <path
      d="M3 5h18v11H3zM9 20h6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    />
  ),
  help: (
    <>
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M10 10a2 2 0 1 1 3 1.7c-.7.4-1 1-1 1.8M12 16v1"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" fill="currentColor" />
      <path d="M12 7v6M12 15v2" stroke="#838f97" strokeWidth="2.2" />
    </>
  ),
} as const;

export type ArmIconName = keyof typeof PATHS;

export function ArmIcon({
  name,
  size = "normal",
  className,
}: {
  readonly name: ArmIconName;
  /** tiny — 13 px, как стрелки на плитках; normal — 18 px; large — трубка. */
  readonly size?: "tiny" | "normal" | "large";
  readonly className?: string;
}) {
  return (
    <span className={`${styles[size]} ${className ?? ""}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {PATHS[name]}
      </svg>
    </span>
  );
}
