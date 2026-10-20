// Живой React/Query/автопилот; подменяется только HTTP на границе браузера.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Card } from "../../shared/api";
import { SessionContext } from "../../shared/session";
import { RealtimeClient } from "../../shared/ws/client";
import { IncidentCard } from "../IncidentCard";
import { CardToolsProvider } from "../tools/CardTools";
import { useToolsStore } from "../tools/toolsStore";
import { TrainerProvider, useTrainer, type TrainerApi } from "./TrainerContext";
import { TrainerCoach } from "./TrainerCoach";
import { trainerStore, type CardVoice } from "./trainerStore";
import { sessionMode, setSessionMode, type CardMode } from "./stages";

export const tick = () => new Promise<void>((done) => setTimeout(done, 50));

// Фикстуры HTTP/кэша, но вся цепочка прав, формы и очереди — производственная.
export const incident: Card = {
  id: "card",
  assignment_id: "assignment",
  session_id: "session",
  trainee_id: "user",
  state: "working",
  appeared_at: "2026-10-19T09:00:00Z",
  delivered_at: "2026-10-19T09:00:00Z",
  opened_at: "2026-10-19T09:00:00Z",
  closed_at: null,
  interrupted_at: null,
  current: { service_number: "1", comment: "" },
  source: {
    number: "100",
    incident_type_code: "fire",
    caller_name: "Учебный заявитель",
    phone_aon: "",
    phone_provided: "",
    phone_scene: "",
    address: {
      city: "Москва",
      okrug: "",
      district: "",
      street: "Учебная",
      house: "1",
      building: "",
      apartment: "",
    },
    description: "Учебное происшествие",
    tags: [],
    victims: false,
    ambulance_refused: false,
    blocked_people: false,
    emergency: false,
    incident_class: "Пожар",
    service_ids: ["101"],
  },
};
export const incidentSession = {
  id: "session",
  kind: "practice",
  status: "running",
  participants: [
    { user_id: "user", workstation_number: 1, dds_service_id: "101", level: 1 },
  ],
  settings_snapshot: { demo: true, spelling_hints: false },
};
export const incidentTraining = {
  card_id: "card",
  revision: 1,
  selected_brigade_ids: [],
  messages: [],
  missing_report_states: [],
};

export async function armCompletion() {
  const select = document.querySelector<HTMLSelectElement>(
    '[data-help="line-status"]',
  )!;
  const comment = document.querySelector<HTMLInputElement>(
    '[data-help="line-comment"]',
  )!;
  Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!.call(select, "completed");
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(comment, "Работы завершены");
  comment.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  document
    .querySelector<HTMLButtonElement>('[data-help="line-confirm"]')!
    .click();
  await tick();
}

export function mountIncident(mode: CardMode = "watch", resetStorage = true) {
  // Remount читает сохранённый режим и owner перехвата, как настоящий АРМ.
  if (resetStorage) {
    localStorage.clear();
    sessionStorage.clear();
    setSessionMode("session", mode);
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["session", "session"], incidentSession);
  client.setQueryData(["sessions"], [incidentSession]);
  client.setQueryData(["cards"], [incident]);
  client.setQueryData(["card-events", "card"], []);
  client.setQueryData(["card-training", "card"], incidentTraining);
  const realtime = new RealtimeClient("user", () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current!: TrainerApi;
  function Screen() {
    current = useTrainer()!;
    const tools = useToolsStore("user");
    return (
      <CardToolsProvider
        store={tools}
        now={0}
        cards={[incident]}
        openedId="card"
        onOpen={() => {}}
      >
        <div data-trainer-block="">
          <IncidentCard
            card={incident}
            services={[]}
            onClose={() => {}}
            softphone={false}
          />
        </div>
        <TrainerCoach cards={[incident]} now={0} reactionS={30} />
      </CardToolsProvider>
    );
  }
  flushSync(() =>
    root.render(
      <SessionContext.Provider
        value={{
          user: {
            id: "user",
            login: "trainee",
            full_name: "Учебный диспетчер",
            role: "trainee",
            workstation_number: 1,
            dds_service_id: "101",
            is_active: true,
          },
          realtime,
        }}
      >
        <QueryClientProvider client={client}>
          <MemoryRouter
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <TrainerProvider onReview={() => {}}>
              <Screen />
            </TrainerProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  );
  return {
    client,
    realtime,
    get api() {
      return current;
    },
    snapshot() {
      return { ...trainerStore.get(), mode: current.mode, note: current.note };
    },
    unmount() {
      flushSync(() => root.unmount());
      realtime.stop();
      client.clear();
      container.remove();
    },
  };
}

export function mountTrainer(mode: CardMode = "watch", resetStorage = true) {
  if (resetStorage) localStorage.clear();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["sessions"], [{ id: "session", kind: "practice" }]);
  client.setQueryData(["cards"], []);
  const container = document.createElement("div");
  const target = document.createElement("div");
  target.innerHTML =
    '<div data-help="card-action"><button data-help="line-confirm">Подтвердить</button></div>';
  target.style.cssText =
    "position:fixed;left:400px;top:300px;width:200px;height:80px";
  document.body.append(container, target);
  let current!: TrainerApi;
  function Read() {
    current = useTrainer()!;
    return <TrainerCoach cards={[]} now={0} reactionS={30} />;
  }
  const root = createRoot(container);
  const voice: CardVoice = {
    cardId: "card",
    sessionId: "session",
    number: "1",
    practice: true,
    closed: false,
    canAct: true,
    step: null,
    rejected: false,
    lineOpen: false,
    tip: null,
    check: null,
    heard: null,
    clarity: null,
    helps: 0,
    summary: "",
  };
  function show(
    sessionId: string,
    cardId: string,
    nextMode: CardMode = "watch",
  ) {
    setSessionMode(sessionId, nextMode);
    flushSync(() =>
      trainerStore.setCard(
        { ...voice, sessionId, cardId },
        { cardElement: () => target },
      ),
    );
  }
  show("session", "card", mode);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <TrainerProvider onReview={() => {}}>
            <Read />
          </TrainerProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return {
    client,
    get api() {
      return current;
    },
    show,
    snapshot() {
      const demo = trainerStore.get().demo;
      return {
        mode: current.mode,
        note: current.note,
        busy: current.busy,
        paused: demo?.paused ?? null,
        demoCard: demo?.cardId ?? null,
        storedMode: sessionMode("session"),
        // Отметки — у пользователя провайдера (stages.ts): читаем через него.
        watchDone: current.done().has("watch"),
      };
    },
    unmount() {
      flushSync(() => root.unmount());
      client.clear();
      trainerStore.setCard(null);
      target.remove();
      container.remove();
    },
  };
}
