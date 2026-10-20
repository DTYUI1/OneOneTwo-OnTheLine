import styles from "./Phone.module.css";

export function SoundButton({
  muted,
  onToggle,
}: {
  readonly muted: boolean;
  readonly onToggle: (muted: boolean) => void;
}) {
  const label = muted ? "Включить звук разговора" : "Выключить звук разговора";
  return (
    <button
      type="button"
      className={styles.soundBtn}
      aria-label={label}
      aria-pressed={!muted}
      title={label}
      onClick={() => onToggle(!muted)}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M11 4 6 8H3v8h3l5 4V4Z" />
        {muted ? (
          <path d="m16 9 6 6m0-6-6 6" />
        ) : (
          <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
        )}
      </svg>
    </button>
  );
}
