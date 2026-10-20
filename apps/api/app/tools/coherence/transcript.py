"""Расшифровка прогона — как лента окна телефона, плюс то, что видно только прогону.

Строка — реплика (кто сказал, что, когда началась и кончилась, откуда взялась) или действие
диспетчера (статус, вводная, ответ, звонок). Время — секунды симуляции от прихода карточки.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

Kind = Literal["speech", "action", "call", "world"]

# Откуда реплика: доклад плана, реплика события, ответ ветки, подмена доклада веткой, повтор
# адреса, фраза окна телефона (банк клиента), диспетчер.
Source = Literal[
    "plan",
    "event",
    "branch",
    "replace",
    "wrong_address",
    "readback",
    "client",
    "dispatcher",
    "service",
    # Живой заявитель (HQ-019): реплики книги заявителя, говорит окно телефона.
    "caller",
    "system",
]


# Ключ реплики окна телефона: снятая с удержания бригада повторяет свой вопрос с вариантами
# ответа, на который диспетчер не ответил (HQ-058, incoming.ts `resumedPhrase`).
QUESTION_REPEAT = "question_repeat"

# Реплики бригады: от сервера (план, события, ветки) и от окна телефона (банк клиента).
BRIGADE_SOURCES = frozenset(
    {"plan", "event", "branch", "replace", "wrong_address", "readback", "client"}
)


@dataclass
class Line:
    at: float
    kind: Kind
    who: str
    text: str
    source: Source = "system"
    end: float | None = None
    call: str | None = None
    # Доклад или событие сценария: ключ («arrival», «readback:met»), служебные поля.
    key: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def spoken_by_brigade(self) -> bool:
        return self.kind == "speech" and self.source in BRIGADE_SOURCES


@dataclass
class Transcript:
    scenario: str
    policy: str
    service: str
    lines: list[Line] = field(default_factory=list)
    closed: bool = False
    final_state: str | None = None
    scores: dict[str, float] = field(default_factory=dict)
    critical: list[str] = field(default_factory=list)
    review: list[str] = field(default_factory=list)
    # Сработавшие события: ключ → секунда срабатывания.
    firings: dict[str, float] = field(default_factory=dict)
    # Звонки диспетчера в службы: номер → секунда набора.
    service_calls: list[tuple[str, float]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    # Служебные данные прогона для инвариантов (сценарий, ключи сообщений).
    data: dict[str, Any] = field(default_factory=dict)

    def add(self, line: Line) -> Line:
        self.lines.append(line)
        return line

    def speech(self) -> list[Line]:
        return [line for line in self.lines if line.kind == "speech"]

    def brigade_speech(self) -> list[Line]:
        return [line for line in self.lines if line.spoken_by_brigade]

    def render(self) -> str:
        """Расшифровка текстом: время, звонок, кто, что, откуда."""
        head = f"### {self.scenario} · {self.policy}"
        rows = [head, ""]
        for line in sorted(self.lines, key=lambda item: (item.at, self.lines.index(item))):
            stamp = _mmss(line.at)
            if line.kind == "call":
                rows.append(f"    {stamp}  ── {line.text}")
            elif line.kind == "action":
                rows.append(f"    {stamp}  [действие] {line.text}")
            elif line.kind == "world":
                rows.append(f"    {stamp}  (мир) {line.text}")
            else:
                origin = line.source + (f":{line.key}" if line.key else "")
                rows.append(f"    {stamp}  {line.who}: {line.text}   ← {origin}")
        closing = f"Карточка закрыта: {self.final_state}" if self.closed else "Карточка НЕ закрыта"
        rows.append("")
        rows.append(f"    {closing}")
        worse = {key: value for key, value in self.scores.items() if value < 1}
        if worse:
            rows.append(
                "    Разбор ниже 1: "
                + ", ".join(f"{key} {value:.2f}" for key, value in sorted(worse.items()))
            )
        if self.critical:
            rows.append("    Критические ошибки: " + ", ".join(self.critical))
        for item in self.errors:
            rows.append(f"    Ошибка прогона: {item}")
        return "\n".join(rows)


def _mmss(seconds: float) -> str:
    whole = int(seconds)
    tenths = int((seconds - whole) * 10)
    return f"{whole // 60:02d}:{whole % 60:02d}.{tenths}"
