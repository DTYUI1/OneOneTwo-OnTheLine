import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_INTERVAL_MS,
  MAX_BUFFERED_BYTES,
  MAX_FRAME_BYTES,
  ownShareState,
  parseFrame,
  ScreenPublisher,
  screenSocketUrl,
  type FrameSink,
} from "./screen";

class FakeSink implements FrameSink {
  readyState = 1;
  bufferedAmount = 0;
  frames: Blob[] = [];
  closed: number | null = null;
  send(data: Blob) {
    this.frames.push(data);
  }
  close(code?: number) {
    this.closed = code ?? 1000;
    this.readyState = 3;
  }
}

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3])]);

describe("ScreenPublisher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("шлёт 5 кадров в секунду, даже если просить чаще", async () => {
    const sink = new FakeSink();
    const publisher = new ScreenPublisher(() => Promise.resolve(jpeg()), sink);
    publisher.paused = false;
    publisher.start();
    // Лишние тики (например, двойной вызов) не дают кадров сверх нормы.
    for (let i = 0; i < 10; i += 1) void publisher.tick();
    await vi.advanceTimersByTimeAsync(1000 - 1);
    expect(sink.frames).toHaveLength(5);
    expect(FRAME_INTERVAL_MS).toBe(200);
    publisher.stop();
  });

  it("пропускает кадр, пока прежний кодируется или сеть не разобрала очередь", async () => {
    const sink = new FakeSink();
    let release: (blob: Blob) => void = () => undefined;
    const publisher = new ScreenPublisher(
      () => new Promise<Blob>((resolve) => (release = resolve)),
      sink,
    );
    publisher.paused = false;
    publisher.start();
    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS * 3);
    expect(sink.frames).toHaveLength(0);
    release(jpeg());
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.frames).toHaveLength(1);
    sink.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS * 3);
    expect(sink.frames).toHaveLength(1);
    expect(publisher.skipped).toBeGreaterThan(0);
    publisher.stop();
  });

  it("не шлёт кадр больше лимита сервера", async () => {
    const sink = new FakeSink();
    const big = new Blob([new Uint8Array(MAX_FRAME_BYTES + 1)]);
    const publisher = new ScreenPublisher(() => Promise.resolve(big), sink);
    publisher.paused = false;
    publisher.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.frames).toHaveLength(0);
    publisher.stop();
  });

  it("после остановки кадров нет и сокет закрыт", async () => {
    const sink = new FakeSink();
    let release: (blob: Blob) => void = () => undefined;
    const publisher = new ScreenPublisher(
      () => new Promise<Blob>((resolve) => (release = resolve)),
      sink,
    );
    publisher.paused = false;
    publisher.start();
    publisher.stop();
    // Кадр, начатый до остановки, тоже не уходит.
    release(jpeg());
    await vi.advanceTimersByTimeAsync(2000);
    expect(sink.frames).toHaveLength(0);
    expect(sink.closed).toBe(1000);
  });

  it("на паузе (преподаватель не смотрит) не снимает и не шлёт кадры", async () => {
    const sink = new FakeSink();
    let grabs = 0;
    let release: (blob: Blob) => void = () => undefined;
    const publisher = new ScreenPublisher(() => {
      grabs += 1;
      return new Promise<Blob>((resolve) => (release = resolve));
    }, sink);
    // Пока сервер не сказал «sharing», показ на паузе.
    publisher.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect([grabs, sink.frames.length]).toEqual([0, 0]);
    publisher.paused = false;
    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS);
    expect(grabs).toBe(1);
    // Пауза пришла, пока кадр кодировался, — он не уходит.
    publisher.paused = true;
    release(jpeg());
    await vi.advanceTimersByTimeAsync(1000);
    expect([grabs, sink.frames.length]).toEqual([1, 0]);
    publisher.paused = false;
    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS);
    release(jpeg());
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.frames).toHaveLength(1);
    publisher.stop();
  });
});

describe("кадры преподавателю", () => {
  it("разбирает UUID ученика и JPEG", async () => {
    const id = "00000000-0000-4000-8000-000000000201";
    const bytes = new Uint8Array(16 + 3);
    id.replaceAll("-", "")
      .match(/../g)!
      .forEach((pair, index) => (bytes[index] = parseInt(pair, 16)));
    bytes.set([0xff, 0xd8, 7], 16);
    const frame = parseFrame(bytes.buffer);
    expect(frame?.userId).toBe(id);
    expect(frame?.jpeg.type).toBe("image/jpeg");
    expect(new Uint8Array(await frame!.jpeg.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 7]),
    );
    expect(parseFrame(new ArrayBuffer(16))).toBeNull();
  });

  it("адрес канала на том же хосте, wss под https", () => {
    const url = screenSocketUrl("abc", "https://arm.local:8443/app/teacher");
    expect(url.toString()).toBe(
      "wss://arm.local:8443/ws/screen?session_id=abc",
    );
  });
});

describe("ownShareState", () => {
  const me = "00000000-0000-0000-0000-000000000001";
  const other = "00000000-0000-0000-0000-000000000002";

  it("после переподключения берёт паузу и просмотр из GET /screens", () => {
    expect(ownShareState([{ user_id: me, state: "paused" }], me)).toEqual({
      requested: true,
      watched: false,
    });
    expect(ownShareState([{ user_id: me, state: "sharing" }], me)).toEqual({
      requested: true,
      watched: true,
    });
  });

  it("requested не трогает просмотр: сокет показа мог только открыться", () => {
    expect(ownShareState([{ user_id: me, state: "requested" }], me)).toEqual({
      requested: true,
    });
  });

  it("чужой показ и пустой ответ — запроса нет", () => {
    expect(ownShareState([{ user_id: other, state: "sharing" }], me)).toEqual({
      requested: false,
    });
    expect(ownShareState(undefined, me)).toEqual({ requested: false });
  });
});
