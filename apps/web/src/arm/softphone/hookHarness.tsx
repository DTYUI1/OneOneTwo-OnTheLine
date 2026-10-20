// Настоящий React в браузерных регрессиях Vitest: без подмены хуков и эффектов.
import { Fragment, type ComponentType, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionContext } from "../../shared/session";
import type { CardEvent, User } from "../../shared/api";
import { RealtimeClient } from "../../shared/ws/client";
import { createRoot } from "react-dom/client";
export { createElement } from "react";
export {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";

/** Подменяется только устройство записи; настоящий хук обрабатывает stop/start. */
export function microphoneHarness() {
  navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  class TestRecorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["учебная запись"]) });
      this.onstop?.();
    }
  }
  window.MediaRecorder = TestRecorder as unknown as typeof MediaRecorder;
}
import { flushSync } from "react-dom";

export function mountHook<Input, Output>(
  useHook: (input: Input) => Output,
  initial: Input,
  Wrap: ComponentType<{ children: ReactNode }> = Fragment,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let value: Output;
  function Probe({ input }: { input: Input }) {
    value = useHook(input);
    return null;
  }
  const render = (input: Input) => {
    flushSync(() =>
      root.render(
        <Wrap>
          <Probe input={input} />
        </Wrap>,
      ),
    );
  };
  render(initial);
  return {
    get current() {
      return value;
    },
    render,
    unmount() {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

export function mountComponent<Props extends object>(
  Component: ComponentType<Props>,
  props: Props,
  Wrap: ComponentType<{ children: ReactNode }> = Fragment,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <Wrap>
        <Component {...props} />
      </Wrap>,
    ),
  );
  return {
    container,
    render(next: Props) {
      flushSync(() =>
        root.render(
          <Wrap>
            <Component {...next} />
          </Wrap>,
        ),
      );
    },
    unmount() {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

export function sessionHarness() {
  const events: CardEvent[] = [];
  const realtime = new RealtimeClient("review", () => {});
  // enqueue подтверждает запись в outbox, а не принятие события сервером.
  realtime.enqueue = async (_cardId, event) => {
    events.push(event);
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["services"], []);
  const user = {
    id: "review",
    role: "trainee",
    full_name: "Учебный диспетчер",
  } as User;
  function Wrap({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <SessionContext.Provider value={{ user, realtime }}>
          {children}
        </SessionContext.Provider>
      </QueryClientProvider>
    );
  }
  return { Wrap, events, client, realtime };
}

/** Управляем только устройство: очередь, отмена и исходы остаются настоящими. */
export function audioHarness() {
  const played: TestAudio[] = [];
  class TestAudio extends EventTarget {
    muted = false;
    volume = 1;
    preload = "";
    paused = true;
    ended = false;
    duration = 10;
    currentTime = 0;
    playbackRate = 1;
    constructor(readonly src: string) {
      super();
    }
    play() {
      this.paused = false;
      played.push(this);
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {}
    load() {}
    finish() {
      this.ended = true;
      this.dispatchEvent(new Event("ended"));
    }
  }
  window.Audio = TestAudio as unknown as typeof Audio;
  return played;
}
