import type { components } from "../../api-client/schema";
import type { PracticeScenario } from "../../arm/catalog/catalogModel";
import type { Scenario, Session } from "./model";

const address = {
  city: "Москва",
  okrug: "",
  district: "",
  street: "Учебная",
  house: "1",
  building: "",
  apartment: "",
};
export function scenario(id: string, service = "MOSLIFT"): Scenario {
  return {
    id,
    version: 2,
    level: 2,
    weight: 2,
    incident_type_code: "lift",
    target_service_id: service,
    status: "approved",
    origin: "template",
    teacher_comment: "",
    coherence_unchecked: false,
    is_manual: true,
    complications: [],
    card: {
      number: "70008602",
      incident_type_code: "lift",
      caller_name: "Учебный заявитель",
      phone_aon: "",
      phone_provided: "",
      phone_scene: "",
      address,
      description: "Учебная карточка",
      tags: [],
      victims: false,
      ambulance_refused: false,
      blocked_people: true,
      emergency: false,
      incident_class: "Застревание в лифте",
      service_ids: [service],
    },
    reference: {
      expected_flow: ["received", "accepted", "completed"],
      required_fields: [],
      expected_service_ids: [service],
      expected_address: address,
      expected_call: {
        required: true,
        service_id: service,
        phone_ext: "458",
        before_s: 60,
        contact_role: "caller",
      },
      expected_comment: "",
    },
  };
}
export const scenarios = [
  scenario("hidden"),
  scenario("lift-second"),
  scenario("foreign", "104"),
  scenario("lift-first"),
];
export const catalog: PracticeScenario[] = [
  {
    id: "foreign",
    version: 2,
    title: "Газ: проверка адреса",
    service_id: "104",
    service_name: "Мосгаз",
    level: 2,
    description: "",
    trains: ["readback_error", "request_service", "silence", "alarm"],
  },
  {
    id: "lift-first",
    version: 2,
    title: "Застрявший лифт: уточнить подъезд и кабину",
    service_id: "MOSLIFT",
    service_name: "Мослифт",
    level: 2,
    description: "",
    trains: ["clarify"],
  },
  {
    id: "lift-second",
    version: 2,
    title: "Лифт: связь с бригадой",
    service_id: "MOSLIFT",
    service_name: "Мослифт",
    level: 2,
    description: "",
    trains: [],
  },
];
export const lesson: Session = {
  id: "lesson",
  title: "Учебное занятие",
  teacher_id: "teacher",
  status: "draft",
  participants: [
    {
      user_id: "trainee",
      workstation_number: 1,
      dds_service_id: "MOSLIFT",
      level: 2,
    },
  ],
  settings_snapshot: {
    reaction_normative_s: 30,
    handling_normative_s: 180,
    critical_cap: 0.5,
    weights: {
      reaction_time: 1,
      handling_time: 1,
      status_flow: 1,
      routing: 1,
      required_fields: 1,
      address: 1,
      call: 1,
    },
    parallel_cards: 1,
    hints_level: 0,
    spelling_hints: false,
    voice_only: false,
    report_choice_factor: 0.5,
    final_shift: false,
    demo: false,
  },
};
export const history = [
  {
    id: "issued",
    session_id: lesson.id,
    participant_id: "trainee",
    scenario_id: "hidden",
    order: 1,
    planned_at: "2026-10-20T09:00:00Z",
    status: "pending",
  },
] satisfies components["schemas"]["Assignment"][];
