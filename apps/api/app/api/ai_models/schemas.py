from typing import Literal

from app.api.foundation.schemas import ContractModel

Mode = Literal["cpu", "gpu"]
# ready — llama.cpp в контейнере видит карту (CUDA или Vulkan); no_driver — карта есть, но
# контейнер её не видит; no_image — нет образа llama.cpp для видеокарты, проверить нечем;
# none — дискретной карты нет; unknown — стенд запущен без проверки (--gpu off, Windows).
GpuState = Literal["none", "no_driver", "no_image", "ready", "unknown"]
Backend = Literal["cuda", "vulkan"]
LoadStatus = Literal["loaded", "loading", "unloaded", "failed", "unknown"]


class AIModelChoice(ContractModel):
    model: str
    mode: Mode
    # «Всё равно использовать видеокарту»: проверка её не подтвердила или памяти мало.
    # Не загрузится — ИИ сам вернётся на процессор.
    force: bool = False


class AIGpuNotice(ContractModel):
    # «Не напоминать»: не предлагать перейти на видеокарту и не предупреждать о драйвере —
    # например, на машине, где драйвер не проверить (Windows). Одна настройка на систему.
    dismissed: bool


class AIGpu(ContractModel):
    state: GpuState
    backend: Backend | None
    device: str | None
    name: str | None
    vram_mb: int | None


class AIHardware(ContractModel):
    cpu_cores: int
    memory_total_bytes: int | None
    gpu: AIGpu
    # У сервера модели есть доступ к видеокарте; forced — дан по --gpu force без подтверждения.
    llm_gpu: bool
    forced: bool


class AIModelMode(ContractModel):
    mode: Mode
    available: bool
    reason: str | None
    can_force: bool
    status: LoadStatus


class AIModel(ContractModel):
    id: str
    title: str
    file: str
    size_bytes: int
    ram_gb: float
    vram_gb: float
    summary: str
    # Зачем выбирать эту модель: администратор решает по ним, а не по названию.
    pros: list[str]
    cons: list[str]
    choose_when: str
    installed: bool
    source: str
    modes: list[AIModelMode]


class AIActiveModel(ContractModel):
    model: str
    mode: Mode
    status: LoadStatus
    # Видеокарта выбрана, но модель на ней не загрузилась: ИИ работает на процессоре.
    fallback: bool


class AIBenchmark(ContractModel):
    model: str
    mode: Mode
    machine: str
    generate_seconds: float | None
    judge_seconds: float | None
    tokens_per_second: float | None
    memory_gb: float | None


class AILocalTiming(ContractModel):
    period_hours: int
    attempts: int
    mean_seconds: float | None


class AIModels(ContractModel):
    ai_enabled: bool
    router: bool
    active: AIActiveModel
    hardware: AIHardware
    gpu_suggestion: bool
    notice_dismissed: bool
    models: list[AIModel]
    benchmarks: list[AIBenchmark]
    local_generation: AILocalTiming
