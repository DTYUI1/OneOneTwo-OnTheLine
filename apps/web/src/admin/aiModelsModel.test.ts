import { describe, expect, it } from "vitest";
import {
  activeLabel,
  compatibilityHint,
  gpuLabel,
  gpuTarget,
  installHint,
  type AIModels,
} from "./aiModelsModel";

const gpuMode = (available: boolean) => ({
  mode: "gpu" as const,
  available,
  reason: available ? null : "Дискретная видеокарта не найдена.",
  can_force: false,
  status: "unloaded" as const,
});

const data = (overrides: Partial<AIModels> = {}): AIModels => ({
  ai_enabled: true,
  router: true,
  active: { model: "qwen3-4b", mode: "cpu", status: "loaded", fallback: false },
  hardware: {
    cpu_cores: 8,
    memory_total_bytes: 32 * 1024 ** 3,
    gpu: {
      state: "ready",
      backend: "cuda",
      device: "CUDA0",
      name: "RTX 3060",
      vram_mb: 12288,
    },
    llm_gpu: true,
    forced: false,
  },
  gpu_suggestion: true,
  notice_dismissed: false,
  models: [
    {
      id: "qwen3-4b",
      title: "Qwen3-4B Instruct 2507",
      file: "qwen3-4b-instruct-2507-q4_k_m.gguf",
      size_bytes: 2497281120,
      ram_gb: 6,
      vram_gb: 4,
      summary: "",
      pros: [],
      cons: [],
      choose_when: "",
      installed: true,
      source: "",
      modes: [
        {
          mode: "cpu",
          available: true,
          reason: null,
          can_force: false,
          status: "loaded",
        },
        gpuMode(true),
      ],
    },
  ],
  benchmarks: [],
  local_generation: { period_hours: 24, attempts: 0, mean_seconds: null },
  ...overrides,
});

describe("модели ИИ словами", () => {
  it("называет работающую модель, режим и загрузку", () => {
    expect(activeLabel(data())).toBe(
      "Qwen3-4B Instruct 2507 · процессор · загружена и работает",
    );
    expect(activeLabel(data({ router: false }))).toContain(
      "сервер модели не отвечает",
    );
    expect(activeLabel(data({ ai_enabled: false }))).toContain(
      "ИИ выключен на этом компьютере",
    );
    expect(
      activeLabel(
        data({
          active: {
            model: "qwen3-4b",
            mode: "gpu",
            status: "failed",
            fallback: true,
          },
        }),
      ),
    ).toBe(
      "Qwen3-4B Instruct 2507 · процессор · видеокарта не загрузила модель",
    );
  });

  it("карта без драйвера — предупреждение, а не предложение ускорить", () => {
    const hardware = {
      ...data().hardware,
      gpu: {
        state: "no_driver" as const,
        backend: null,
        device: null,
        name: "RTX 3050 Mobile",
        vram_mb: null,
      },
      llm_gpu: false,
    };
    const label = gpuLabel(hardware);
    expect(label.tone).toBe("warn");
    expect(label.hint).toContain("Попросите специалиста");
    expect(
      gpuLabel({
        ...hardware,
        gpu: {
          state: "none",
          backend: null,
          device: null,
          name: null,
          vram_mb: null,
        },
      }),
    ).toMatchObject({ value: "Нет", tone: "neutral" });
  });

  it("рабочая карта: «можно перевести», с памятью", () => {
    expect(gpuLabel(data().hardware)).toEqual({
      value: "RTX 3060, 12 ГБ",
      hint: "Рабочая: ИИ можно перевести на видеокарту.",
      tone: "ok",
    });
  });

  it("принудительный доступ к карте — предупреждение, что вернётся процессор", () => {
    const label = gpuLabel({ ...data().hardware, forced: true });
    expect(label.tone).toBe("warn");
    expect(label.hint).toContain("вернётся на процессор");
  });

  it("«не напоминать» снимает предупреждающий цвет, сведения остаются", () => {
    const hardware = { ...data().hardware, forced: true };
    expect(gpuLabel(hardware, true)).toMatchObject({ tone: "neutral" });
    expect(gpuLabel(hardware, true).hint).toBe(gpuLabel(hardware).hint);
    expect(gpuLabel(data().hardware, true).tone).toBe("ok");
  });

  it("на видеокарту переводим текущую модель, если её режим доступен", () => {
    expect(gpuTarget(data())?.id).toBe("qwen3-4b");
    const blocked = data();
    blocked.models[0].modes[1] = gpuMode(false);
    expect(gpuTarget(blocked)).toBeNull();
  });

  it("подсказка установки — модель, помощь специалиста и размер", () => {
    expect(installHint(data().models[0])).toBe(
      "Модель ещё не установлена. Попросите специалиста установить Qwen3-4B Instruct 2507. " +
        "Для загрузки нужен интернет; размер файла — 2,3 ГБ.",
    );
  });
});

it("предупреждает о памяти даже до установки, но учитывает подходящую видеокарту", () => {
  const box = data().hardware;
  box.memory_total_bytes = 15 * 1024 ** 3;
  box.gpu.vram_mb = 4096;
  const model = {
    ...data().models[0],
    installed: false,
    ram_gb: 30,
    vram_gb: 18,
  };
  expect(compatibilityHint(model, box)).toContain(
    "Не подойдёт этому компьютеру",
  );
  box.gpu.vram_mb = 24576;
  expect(compatibilityHint(model, box)).toBeNull();
  box.gpu.vram_mb = null;
  expect(compatibilityHint(model, box)).toContain("неизвестен");
});
