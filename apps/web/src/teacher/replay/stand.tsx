// Стенд реплея: разобранная карточка с ошибками, без backend.
// Открывается в dev-режиме, в сборку не попадает.

import { createRoot } from "react-dom/client";
import { Stage } from "./Replay";
import {
  buildTimeline,
  type Card,
  type Service,
  type Settings,
  type StoredEvent,
} from "./timeline";
import type { Evaluation } from "./useReplay";
import "../../shared/tokens.css";

const START = Date.parse("2026-09-22T09:00:00.000Z");
const at = (offsetS: number) => new Date(START + offsetS * 1000).toISOString();

let serial = 0;
const event = (
  offsetS: number,
  type: string,
  payload: StoredEvent["payload"] = {},
): StoredEvent => ({
  id: `e-${serial++}`,
  card_id: "card-1",
  actor_id: "u-1",
  client_event_id: `ce-${serial}`,
  client_ts: at(offsetS),
  server_ts: at(offsetS),
  clock_offset_ms: 0,
  type,
  payload,
});

// Прогон с тремя настоящими промахами: поздняя реакция, звонок не в ту
// службу и обработка дольше норматива.
const events: StoredEvent[] = [
  event(0, "deliver"),
  event(48, "open"),
  event(61, "status_change", { state: "accepted", comment: "Принял заявку" }),
  event(70, "field_change", { field: "service_number", value: "23" }),
  event(95, "status_change", {
    state: "responding",
    comment: "Направлен наряд",
  }),
  event(120, "call_dial", { call_id: "c-1", phone_ext: "103" }),
  event(123, "call_answer", { call_id: "c-1" }),
  event(140, "call_hangup", { call_id: "c-1" }),
  event(150, "comment", { comment: "Уточнил адрес у службы" }),
  event(214, "status_change", {
    state: "completed",
    comment: "Работы завершены",
  }),
];

const card: Card = {
  id: "card-1",
  assignment_id: "a-1",
  trainee_id: "u-1",
  session_id: "s-1",
  state: "completed",
  appeared_at: at(0),
  delivered_at: at(0),
  opened_at: at(48),
  closed_at: at(214),
  interrupted_at: null,
  source: {
    number: "36814845",
    incident_class: "пожар: квартира",
    service_ids: ["102"],
  } as Card["source"],
  current: {} as Card["current"],
};

const services: Service[] = [
  ["102", "Служба 102"],
  ["103", "Скорая помощь"],
].map(([id, name]) => ({
  id,
  code: id,
  name,
  category: "demo",
  phone_ext: id,
  voice_profile: "voice-1",
  is_active: true,
}));

const settings = {
  reaction_normative_s: 30,
  handling_normative_s: 180,
} as Settings;

const evaluation: Evaluation = {
  id: "ev-1",
  card_id: "card-1",
  trainee_id: "u-1",
  version: 2,
  status: "complete",
  total: 0.62,
  criteria: [
    {
      key: "reaction_time",
      score: 0,
      weight: 1,
      critical: false,
      evidence: [],
      explanation: "Открытие через 48 с при нормативе 30 с.",
    },
    {
      key: "handling_time",
      score: 0.3,
      weight: 1,
      critical: false,
      evidence: [],
      explanation: "Закрытие через 214 с при нормативе 180 с.",
    },
    {
      key: "status_flow",
      score: 1,
      weight: 1,
      critical: false,
      evidence: [],
      explanation: "Порядок статусов соблюдён.",
    },
    {
      key: "routing",
      score: 0,
      weight: 1,
      critical: true,
      evidence: [],
      explanation: "Доклад ушёл в 103, карточка адресована 102.",
    },
    {
      key: "required_fields",
      score: 1,
      weight: 1,
      critical: false,
      evidence: [],
      explanation: "Поля заполнены.",
    },
    {
      key: "address",
      score: 1,
      weight: 1,
      critical: false,
      evidence: [],
      explanation: "Адрес совпал с эталоном.",
    },
    {
      key: "call",
      score: 1,
      weight: 1,
      critical: false,
      evidence: [],
      explanation: "Звонок состоялся в пределах норматива.",
    },
  ],
  model_info: { rules: "MVP-STUB", semantic: "off", llm: "off" },
  teacher_comment: "Разберите выбор службы с преподавателем.",
};

const input = { card, events, services, settings };

createRoot(document.getElementById("root")!).render(
  <>
    <Stage
      input={input}
      timeline={buildTimeline(input)}
      evaluation={evaluation}
    />
    <p style={{ padding: "0 16px 16px", maxWidth: "620px", opacity: 0.8 }}>
      Переместите ползунок или нажмите «следующая ошибка →». Слева показан
      журнал: ошибки отмечены красным. Справа показаны карточка на выбранной
      секунде и вердикт. Оценка поступает с сервера и здесь не пересчитывается.
    </p>
  </>,
);
