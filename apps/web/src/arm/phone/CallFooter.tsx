import type { ReactNode } from "react";
import styles from "./Phone.module.css";

/** Отбой не прокручивается вместе с длинными вариантами ответа. */
export function CallFooter({
  children,
  onHangup,
  disabled = false,
  title,
}: {
  readonly children: ReactNode;
  readonly onHangup?: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
}) {
  return (
    <div
      className={styles.callFooter}
      role="group"
      aria-label="Действия разговора"
    >
      <div
        className={styles.talkHints}
        role="group"
        aria-label="Ответ"
        data-help="phone-answer"
      >
        {children}
      </div>
      {onHangup && (
        <button
          type="button"
          className={styles.hangup}
          onClick={onHangup}
          disabled={disabled}
          aria-label="Положить трубку"
          title={title ?? "Положить трубку"}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 15v-4c5-5 13-5 18 0v4l-5-1v-3a13 13 0 0 0-8 0v3l-5 1Z" />
          </svg>
        </button>
      )}
    </div>
  );
}
