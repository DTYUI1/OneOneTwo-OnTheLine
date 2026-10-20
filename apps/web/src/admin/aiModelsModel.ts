// «Модели ИИ» (HQ-016): состояние видеокарты, режимов и загрузки словами для администратора.
import type { components } from "../api-client/schema";

export type AIModels = components["schemas"]["AIModels"];
export type AIModel = components["schemas"]["AIModel"];
export type Mode = components["schemas"]["AIModelChoice"]["mode"];

export const MODE_LABELS: Record<Mode, string> = {
  cpu: "Процессор",
  gpu: "Видеокарта",
};

const STATUS_LABELS: Record<AIModels["active"]["status"], string> = {
  loaded: "загружена и работает",
  loading: "загружается…",
  unloaded: "загрузится при первой задаче",
  failed: "не загрузилась",
  unknown: "сервер модели не отвечает",
};

const gib = (bytes: number) => bytes / 1024 ** 3;

export function sizeLabel(bytes: number): string {
  return `${gib(bytes).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
}

export function activeLabel(data: AIModels): string {
  const model = data.models.find((item) => item.id === data.active.model);
  const name = model?.title ?? data.active.model;
  if (!data.ai_enabled)
    return `${name} · ${MODE_LABELS[data.active.mode].toLowerCase()} · ИИ выключен на этом компьютере`;
  if (data.active.fallback)
    return `${name} · процессор · видеокарта не загрузила модель`;
  const status = data.router
    ? STATUS_LABELS[data.active.status]
    : STATUS_LABELS.unknown;
  return `${name} · ${MODE_LABELS[data.active.mode].toLowerCase()} · ${status}`;
}

/** Видеокарта словами: что есть и что сделать, чтобы ей воспользоваться. */
export function gpuLabel(
  hardware: AIModels["hardware"],
  dismissed = false,
): {
  value: string;
  hint: string;
  tone: "ok" | "warn" | "neutral";
} {
  const label = describeGpu(hardware);
  // «Не напоминать»: сведения остаются, но без предупреждающего цвета.
  return dismissed && label.tone === "warn"
    ? { ...label, tone: "neutral" }
    : label;
}

function describeGpu(hardware: AIModels["hardware"]): {
  value: string;
  hint: string;
  tone: "ok" | "warn" | "neutral";
} {
  const { gpu } = hardware;
  const name = gpu.name ?? "Видеокарта";
  const memory = gpu.vram_mb ? `, ${Math.round(gpu.vram_mb / 1024)} ГБ` : "";
  if (hardware.forced)
    return {
      value: `${name}${memory}`,
      hint: "Видеокарта включена вручную, без успешной проверки. Если модель не загрузится, ИИ вернётся на процессор.",
      tone: "warn",
    };
  switch (gpu.state) {
    case "ready":
      return hardware.llm_gpu
        ? {
            value: `${name}${memory}`,
            hint: "Рабочая: ИИ можно перевести на видеокарту.",
            tone: "ok",
          }
        : {
            value: `${name}${memory}`,
            hint: "Видеокарта работает, но пока не используется для ИИ. Попросите специалиста подключить её в настройках запуска.",
            tone: "warn",
          };
    case "no_driver":
      return {
        value: name,
        hint: "Не удалось подключить видеокарту. ИИ работает на процессоре. Попросите специалиста проверить установку и доступ к видеокарте.",
        tone: "warn",
      };
    case "no_image":
      return {
        value: name,
        hint: "Не установлена программа для работы ИИ на видеокарте. ИИ работает на процессоре. Для настройки обратитесь к специалисту.",
        tone: "warn",
      };
    case "none":
      return {
        value: "Нет",
        hint: "ИИ работает на процессоре.",
        tone: "neutral",
      };
    default:
      return {
        value: "Не проверялась",
        hint: "Видеокарта не проверялась при запуске. Для её подключения обратитесь к специалисту.",
        tone: "neutral",
      };
  }
}

export function machineLabel(hardware: AIModels["hardware"]): string {
  const memory = hardware.memory_total_bytes
    ? `, память ${Math.round(gib(hardware.memory_total_bytes))} ГБ`
    : "";
  return `${hardware.cpu_cores} ядер${memory}`;
}

/** Модель с режимом «видеокарта», в который можно перейти прямо сейчас. */
export function gpuTarget(data: AIModels): AIModel | null {
  const usable = (model: AIModel) =>
    model.modes.some((mode) => mode.mode === "gpu" && mode.available);
  const current = data.models.find((model) => model.id === data.active.model);
  if (current && usable(current)) return current;
  return data.models.find(usable) ?? null;
}

export function installHint(model: AIModel): string {
  return (
    `Модель ещё не установлена. Попросите специалиста установить ${model.title}. ` +
    `Для загрузки нужен интернет; размер файла — ${sizeLabel(model.size_bytes)}.`
  );
}

export function gpuReminder(data: AIModels): string {
  if (data.notice_dismissed) return "Напоминание о видеокарте скрыто.";
  if (data.active.fallback)
    return "Видеокарта не загрузила модель. ИИ работает на процессоре.";
  if (data.hardware.gpu.state === "ready" && data.hardware.llm_gpu)
    return data.active.mode === "gpu"
      ? "ИИ использует видеокарту."
      : "Видеокарта готова к работе. Можно ускорить генерацию и ИИ-проверку.";
  if (data.hardware.gpu.state === "none")
    return "Видеокарта не найдена. ИИ работает на процессоре.";
  return "Видеокарта не проверена на этом компьютере. Если она не нужна, скройте напоминание.";
}

export function compatibilityHint(
  model: AIModel,
  hardware: AIModels["hardware"],
): string | null {
  const ram = hardware.memory_total_bytes;
  if (ram === null || ram >= model.ram_gb * 0.9 * 1024 ** 3) return null;
  const gpu = hardware.gpu;
  if (gpu.vram_mb === null && gpu.state !== "none")
    return `Для процессора нужно ${model.ram_gb} ГБ памяти, здесь ${Math.round(gib(ram))}. Объём видеопамяти неизвестен.`;
  if (gpu.state !== "none" && (gpu.vram_mb ?? 0) >= model.vram_gb * 1024)
    return null;
  return `Не подойдёт этому компьютеру: нужно ${model.ram_gb} ГБ памяти, здесь ${Math.round(gib(ram))}; или видеокарта от ${model.vram_gb} ГБ.`;
}
