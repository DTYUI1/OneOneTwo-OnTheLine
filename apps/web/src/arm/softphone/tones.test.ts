import { afterEach, describe, expect, it, vi } from "vitest";

import { createTones, lineHiss } from "./tones";

/** Минимальный Web Audio: только то, что трогает шипение линии. */
class FakeParam {
  value = 0;
  readonly ramps: number[] = [];
  setValueAtTime(value: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number) {
    this.ramps.push(value);
    this.value = value;
  }
  cancelScheduledValues() {}
}

class FakeNode {
  connect<T>(next: T): T {
    return next;
  }
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

const sources: FakeSource[] = [];
const gains: { gain: FakeParam }[] = [];

class FakeContext {
  state = "running";
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  createBuffer(_channels: number, frames: number) {
    const data = new Float32Array(frames);
    return { getChannelData: () => data };
  }
  createBufferSource() {
    const source = new FakeSource();
    sources.push(source);
    return source;
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), {
      type: "",
      frequency: new FakeParam(),
    });
  }
  createGain() {
    const gain = Object.assign(new FakeNode(), { gain: new FakeParam() });
    gains.push(gain);
    return gain;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  sources.length = 0;
  gains.length = 0;
});

describe("шипение линии", () => {
  it("звучит только в разговоре, не при «звук выкл.» и не после занятия", () => {
    expect(lineHiss("talking", false, false)).toBe(true);
    for (const state of ["idle", "dialing", "ringing", "ended"] as const)
      expect(lineHiss(state, false, false)).toBe(false);
    expect(lineHiss("talking", true, false)).toBe(false);
    expect(lineHiss("talking", false, true)).toBe(false);
  });

  it("включается плавно, один раз, и гаснет до нуля", () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const tones = createTones();
    tones.line(true);
    tones.line(true);
    expect(sources).toHaveLength(1);
    const [source] = sources;
    const level = gains[0].gain;
    expect(source.loop && source.started).toBe(true);
    expect(level.ramps.at(-1)).toBeGreaterThan(0);
    expect(level.ramps.at(-1)).toBeLessThan(0.02);

    tones.line(false);
    expect(level.ramps.at(-1)).toBe(0);
    expect(source.stopped).toBe(true);
  });

  it("гудки не трогают шипение, а закрытие гасит всё", () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const tones = createTones();
    tones.line(true);
    tones.stop();
    expect(sources[0].stopped).toBe(false);
    tones.close();
    expect(sources[0].stopped).toBe(true);
    expect(gains[0].gain.ramps.at(-1)).toBe(0);
  });

  it("без Web Audio молчит и не падает", () => {
    vi.stubGlobal("AudioContext", undefined);
    const tones = createTones();
    expect(() => tones.line(true)).not.toThrow();
  });
});
