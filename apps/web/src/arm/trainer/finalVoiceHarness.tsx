// Браузерная приёмка: настоящий АРМ/React/Query/IndexedDB; подменяем только устройства и HTTP.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionContext } from "../../shared/session";
import { RealtimeClient } from "../../shared/ws/client";
import type { OutboxOutcome } from "../../shared/ws/outbox";
import { ArmPage } from "../ArmPage";
import { incident, incidentSession } from "./takeOverHarness";
import { setSessionMode } from "./stages";
import "../../shared/tokens.css";
import { MascotToggle } from "../../shared/mascot/Mascot";

export function mountMascotToggle() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<MascotToggle />));
  return () => {
    flushSync(() => root.unmount());
    container.remove();
  };
}

/** Никакого доступа к физическому микрофону, динамикам или синтезатору речи. */
export function deviceBoundary() {
  const devices: FakeAudio[] = [];
  class FakeAudio extends EventTarget {
    played = 0;
    pauses = 0;
    paused = true;
    ended = false;
    duration = 3;
    currentTime = 0;
    playbackRate = 1;
    preload = "";
    constructor(readonly src: string) {
      super();
      devices.push(this);
    }
    play() {
      this.played += 1;
      this.paused = false;
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    }
    pause() {
      this.pauses += 1;
      this.paused = true;
    }
    removeAttribute() {}
    load() {}
    finish() {
      this.ended = true;
      this.dispatchEvent(new Event("ended"));
    }
  }
  window.Audio = FakeAudio as unknown as typeof Audio;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  const parameter = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  class FakeNode {
    connect<T>(next: T): T {
      return next;
    }
    disconnect() {}
  }
  class FakeSource extends FakeNode {
    buffer: unknown = null;
    loop = false;
    frequency = parameter();
    start() {}
    stop() {}
  }
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    sampleRate = 8000;
    destination = new FakeNode();
    createOscillator() {
      return new FakeSource();
    }
    createGain() {
      return Object.assign(new FakeNode(), { gain: parameter() });
    }
    createBuffer(_channels: number, frames: number) {
      const data = new Float32Array(frames);
      return { getChannelData: () => data };
    }
    createBufferSource() {
      return new FakeSource();
    }
    createBiquadFilter() {
      return Object.assign(new FakeNode(), {
        type: "",
        frequency: parameter(),
        Q: parameter(),
      });
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }
  window.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
  Object.defineProperty(window, "webkitAudioContext", {
    configurable: true,
    value: FakeAudioContext,
  });
  navigator.mediaDevices.getUserMedia = async () => {
    throw new Error("Приёмка не использует микрофон");
  };
  if (window.speechSynthesis)
    window.speechSynthesis.speak = () => {
      throw new Error("Приёмка не использует системный TTS");
    };
  // RealtimeClient/очередь реальные; WebSocket не подключается к внешнему серверу.
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  window.WebSocket = FakeSocket as unknown as typeof WebSocket;
  return devices;
}

export const ids = {
  card: "10000000-0000-4000-8000-000000000001",
  session: "10000000-0000-4000-8000-000000000002",
  user: "10000000-0000-4000-8000-000000000003",
  call: "10000000-0000-4000-8000-000000000004",
  outgoing: "10000000-0000-4000-8000-000000000005",
  delivery: "10000000-0000-4000-8000-000000000006",
  target: "10000000-0000-4000-8000-000000000007",
  brigade: "10000000-0000-4000-8000-000000000008",
  other: "10000000-0000-4000-8000-000000000009",
};

export function phoneFixture() {
  const card = {
    ...incident,
    id: ids.card,
    session_id: ids.session,
    trainee_id: ids.user,
    appeared_at: new Date().toISOString(),
  };
  const other = {
    ...card,
    id: ids.other,
    source: {
      ...card.source,
      number: "200",
      description: "Другая учебная карточка",
    },
  };
  const session = {
    ...incidentSession,
    id: ids.session,
    participants: [{ ...incidentSession.participants[0], user_id: ids.user }],
    settings_snapshot: {
      demo: false,
      final_shift: true,
      parallel_cards: 2,
      spelling_hints: false,
    },
  };
  const target = {
    id: ids.target,
    brigade_id: ids.brigade,
    service_id: "101",
    name: "Учебный расчёт",
    phone_ext: "201",
    voice_profile: "denis",
    is_active: true,
  };
  const training = {
    card_id: ids.card,
    revision: 1,
    selected_brigade_ids: [ids.brigade],
    missing_report_states: [],
    incoming: [
      {
        call_id: ids.call,
        brigade_id: ids.brigade,
        call_target_id: ids.target,
        started_at: new Date().toISOString(),
        priority: "normal",
      },
    ],
    messages: [
      {
        state: "delivered",
        presented_at: null,
        reply_key: null,
        delivery: {
          delivery_id: ids.delivery,
          call_id: ids.outgoing,
          brigade_id: ids.brigade,
          call_target_id: ids.target,
          message: {
            id: "final-report",
            version: 1,
            text: "Учебный расчёт прибыл. Как приняли?",
            audio: { url: "/final-report.ogg", duration_ms: 3000, version: 1 },
          },
          reply_options: [],
          reply_by: null,
        },
      },
    ],
  };
  return { card, other, session, target, training };
}

export const phoneTimeline: unknown[] = [];
export const phoneOutcomes: OutboxOutcome[] = [];
export function phoneSnapshot() {
  return {
    at: Date.now(),
    title: document.title,
    controls: [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-help="card-phone"] button',
      ),
    ].map((button) => ({
      text: button.textContent,
      reply: button.dataset.reply,
      disabled: button.disabled,
      visible:
        button.getBoundingClientRect().width > 0 &&
        getComputedStyle(button).visibility === "visible",
    })),
    queries: phoneApp?.client
      .getQueryCache()
      .getAll()
      .map((query) => ({
        key: query.queryKey,
        status: query.state.status,
        fetching: query.state.fetchStatus,
        data: query.state.data,
      })),
    devices: audioDevices.map(({ src, played, pauses, ended, paused }) => ({
      src,
      played,
      pauses,
      ended,
      paused,
    })),
    outcomes: [...phoneOutcomes],
  };
}
export let phoneApp: ReturnType<typeof mountPhone> | undefined;
export let audioDevices: ReturnType<typeof deviceBoundary> = [];
export function mountPhone() {
  localStorage.clear();
  sessionStorage.clear();
  audioDevices = deviceBoundary();
  const fixture = phoneFixture();
  setSessionMode(ids.session, "solo");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["sessions"], [fixture.session]);
  client.setQueryData(["session", ids.session], fixture.session);
  client.setQueryData(["cards"], [fixture.card, fixture.other]);
  client.setQueryData(
    ["services"],
    [{ id: "101", name: "Пожарная охрана", phone_ext: "101", is_active: true }],
  );
  client.setQueryData(["brigades", "101"], []);
  client.setQueryData(["call-targets", "101"], [fixture.target]);
  client.setQueryData(["card-training", ids.card], fixture.training);
  client.setQueryData(["card-training", ids.other], {
    card_id: ids.other,
    revision: 1,
    selected_brigade_ids: [],
    messages: [],
    missing_report_states: [],
  });
  client.setQueryData(["card-events", ids.card], []);
  client.setQueryData(["card-events", ids.other], []);
  client.setQueryData(["progress"], null);
  client.setQueryData(["background-cards", ids.session], []);
  const realtime = new RealtimeClient(ids.user, () => {});
  const stopOutcomes = realtime.subscribeOutcomes((outcome) =>
    phoneOutcomes.push(outcome),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <SessionContext.Provider
        value={{
          user: {
            id: ids.user,
            login: "fixture-trainee",
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
            initialEntries={[`/arm/cards/${ids.other}`]}
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <Routes>
              <Route path="/arm/*" element={<ArmPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  );
  const observe = () => phoneTimeline.push(structuredClone(phoneSnapshot()));
  const unsubscribe = client.getQueryCache().subscribe(observe);
  const observer = new MutationObserver(observe);
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  const app = {
    client,
    realtime,
    fixture,
    unmount() {
      observer.disconnect();
      unsubscribe();
      stopOutcomes();
      flushSync(() => root.unmount());
      realtime.stop();
      client.clear();
      container.remove();
    },
  };
  phoneApp = app;
  observe();
  return app;
}
