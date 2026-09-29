// Значки экрана оператора 112 — по docs/screenshots/card_112/01–09.

import type { ReactNode } from "react";

function Icon({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"
      />
    </svg>
  );
}

export function SmsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 1-2zm4 7a1.2 1.2 0 1 0 0 .01zm4 0a1.2 1.2 0 1 0 0 .01zm4 0a1.2 1.2 0 1 0 0 .01z"
      />
    </svg>
  );
}

export function QuestionIcon() {
  return (
    <Icon size={14}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

export function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"
      />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <Icon size={14}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
    </Icon>
  );
}

export function MapIcon() {
  return (
    <Icon size={18}>
      <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
      <path d="M9 3v15M15 6v15" />
    </Icon>
  );
}

export function TranslateIcon() {
  return (
    <Icon size={20}>
      <path d="M3 5h9M7.5 3v2M5 5c1 4 4 7 7 8M10 5c-1 4-4 7-7 8" />
      <path d="M13 21l4-10 4 10M14.5 17.5h5" />
    </Icon>
  );
}

export function UnlinkIcon() {
  return (
    <Icon size={26}>
      <path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 4 8" />
      <path d="M8 12h4M3 3l18 18" />
    </Icon>
  );
}

export function StopwatchIcon() {
  return (
    <Icon size={26}>
      <circle cx="12" cy="14" r="8" />
      <path d="M12 10v4l2 2M10 2h4M12 2v4" />
    </Icon>
  );
}

export function HandIcon() {
  return (
    <Icon size={26}>
      <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-6-3l-3.5-4.5a2 2 0 0 1 3-2.6L6 14" />
    </Icon>
  );
}

export function BellIcon() {
  return (
    <Icon size={26}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M2 8c0-2 1-4 2-5M22 8c0-2-1-4-2-5" />
    </Icon>
  );
}

export function AlertMessageIcon() {
  return (
    <Icon size={26}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v4M12 14h.01" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon size={26}>
      <path d="M18 6L6 18M6 6l12 12" />
    </Icon>
  );
}
