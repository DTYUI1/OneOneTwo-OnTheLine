"""Расчёт учебного времени I-TIME: legacy v1, v2 и v3 (contracts/I-TIME.md).

Поведение совпадает с `apps/web/src/shared/timing.ts` и проверяется теми же 42 общими
примерами `contracts/examples/timing-v2.json` и `timing-v3.json`. Времена переводятся в
целые миллисекунды, как `Date.parse`, чтобы Python и браузер давали одинаковые числа.

Формулы (секунды):
- v2/v1: реакция = первый deliver → первый open; v3: первое direct → первый
  «Принята/Не принята»;
- обработка = первый open → terminal; активная = обработка − объединение
  подтверждённых интервалов ожидания в её границах;
- превышение: v1/v2 сравнивают норматив с полной обработкой, v3 — с активной;
  только при качестве verified/legacy, иначе None.

Реализация капитана для разблокировки C-06; владелец V-01 может заменить её
при условии прохождения тех же примеров.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from evalcore.timing_contract import (
    ClockSample,
    TimingEvent,
    TimingEvidence,
    TimingInput,
    TimingPolicy,
    TimingResult,
)

# Порядок перечисления схемы — так же аномалии идут в результате (I-TIME v3, п.7).
ANOMALY_ORDER = (
    "missing_direct",
    "missing_deliver",
    "missing_open",
    "missing_primary_status",
    "missing_terminal",
    "non_monotonic",
    "waiting_unavailable",
    "untrusted_clock",
)
# Допуск проверки формулы midpoint: 1 мс (I-TIME, «Проверяемая синхронизация»).
OFFSET_FORMULA_TOLERANCE_MS = 1.0


EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _ms(value: str) -> int:
    """ISO UTC → целые миллисекунды эпохи (как Date.parse: доли мс отбрасываются)."""
    delta = datetime.fromisoformat(value.replace("Z", "+00:00")) - EPOCH
    return delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000


def _iso(ms: float) -> str:
    """Миллисекунды → ISO с тремя знаками и Z (как toISOString, с отбрасыванием долей)."""
    moment = EPOCH + timedelta(milliseconds=int(ms))
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class _Normalized:
    at: float
    evidence: TimingEvidence
    trusted: bool


def _valid_sample(clock: ClockSample, policy: TimingPolicy) -> bool:
    """Образец ws_midpoint_v2 пригоден: есть ответ, RTT в пределах и поправка по формуле."""
    if clock.client_received_at is None or clock.offset_ms is None:
        return False
    sent = _ms(clock.client_sent_at)
    received = _ms(clock.client_received_at)
    rtt = received - sent
    if rtt < 0 or rtt > policy.max_rtt_ms:
        return False
    expected = _ms(clock.server_at) - (sent + received) / 2
    return abs(expected - clock.offset_ms) <= OFFSET_FORMULA_TOLERANCE_MS


def _normalize(event: TimingEvent, policy: TimingPolicy | None) -> _Normalized:
    """Нормализованное время события и причина выбора источника (I-TIME, синхронизация)."""
    server_at = _ms(event.server_ts)

    def fallback(reason: str) -> _Normalized:
        return _Normalized(
            server_at,
            TimingEvidence(event.event_id, _iso(server_at), "server_fallback", reason),  # type: ignore[arg-type]
            False,
        )

    if policy is None:
        # Legacy v1 сохраняет прежние client_ts без поправки.
        at = _ms(event.client_ts)
        return _Normalized(
            at, TimingEvidence(event.event_id, _iso(at), "legacy_client", "legacy"), True
        )
    if event.kind == "direct":
        # Направление фиксирует сервер: часы клиента не участвуют (I-TIME v3).
        return _Normalized(
            server_at,
            TimingEvidence(event.event_id, _iso(server_at), "server", "server_event"),
            True,
        )
    clock = event.clock
    if clock is None:
        return fallback("missing_clock")
    if clock.method == "legacy_one_way":
        return fallback("legacy_clock")
    if not _valid_sample(clock, policy):
        return fallback("invalid_sample")
    client_at = _ms(event.client_ts)
    age = client_at - _ms(clock.client_received_at or "")
    if age < 0 or age > policy.max_sample_age_ms:
        return fallback("stale_sample")
    corrected = client_at + float(clock.offset_ms or 0)
    if corrected > server_at + policy.future_tolerance_ms:
        return fallback("future_event")
    if server_at - corrected > policy.max_buffer_delay_ms:
        return fallback("buffer_exceeded")
    return _Normalized(
        corrected,
        TimingEvidence(event.event_id, _iso(corrected), "corrected_client", "verified"),
        True,
    )


def _span(start: float | None, end: float | None, anomalies: set[str]) -> float | None:
    """Длительность в секундах; отрицательная — нарушение хронологии, а не ноль."""
    if start is None or end is None:
        return None
    if end < start:
        anomalies.add("non_monotonic")
        return None
    return (end - start) / 1000


def _union_seconds(value: TimingInput, start: float, end: float) -> float:
    """Длина объединения интервалов ожидания в границах [start, end] (I-TIME п.5)."""
    clipped = sorted(
        (
            max(_ms(item.started_at), start),
            min(end if item.ended_at is None else _ms(item.ended_at), end),
        )
        for item in value.waiting or []
    )
    total = 0.0
    cursor = float("-inf")
    for begin, finish in clipped:
        if finish <= begin:
            continue
        begin = max(begin, cursor)
        if finish > begin:
            total += finish - begin
        cursor = max(cursor, finish)
    return total / 1000


def _is_status(event: TimingEvent, states: tuple[str, ...]) -> bool:
    return event.kind == "status" and (event.state or "") in states


def _terminal_index(events: list[TimingEvent], version: int) -> int:
    """Индекс terminal-события по правилам версии; -1 — попытка не завершена."""
    closing = ("completed", "refused", "rejected") if version == 1 else ("completed", "refused")
    first = next(
        (i for i, e in enumerate(events) if e.kind == "redirect" or _is_status(e, closing)), -1
    )
    if first >= 0 or version != 3:
        return first
    # v3: окончательная «Не принята» без последующей «Принята» завершает обработку.
    primary = [i for i, e in enumerate(events) if _is_status(e, ("accepted", "rejected"))]
    return primary[-1] if primary and events[primary[-1]].state == "rejected" else -1


def _first(events: list[TimingEvent], predicate) -> int:  # type: ignore[no-untyped-def]
    return next((i for i, event in enumerate(events) if predicate(event)), -1)


def calculate_timing(value: TimingInput) -> TimingResult:
    """Рассчитать TimingResult; версия — по снимку политики, `policy=None` — legacy v1."""
    policy = value.policy
    version = 1 if policy is None else policy.timing_version
    events = value.events
    normalized = [_normalize(event, policy) for event in events]

    def at(index: int) -> float | None:
        return normalized[index].at if index >= 0 else None

    anomalies: set[str] = set()
    if version == 3:
        reaction_start = _first(events, lambda e: e.kind == "direct")
        reaction_end = _first(events, lambda e: _is_status(e, ("accepted", "rejected")))
    else:
        reaction_start = _first(events, lambda e: e.kind == "deliver")
        reaction_end = _first(events, lambda e: e.kind == "open")
    open_index = _first(events, lambda e: e.kind == "open")
    terminal = _terminal_index(events, version)

    if reaction_start < 0:
        anomalies.add("missing_direct" if version == 3 else "missing_deliver")
    if open_index < 0:
        anomalies.add("missing_open")
    if version == 3 and reaction_end < 0:
        anomalies.add("missing_primary_status")
    if terminal < 0:
        anomalies.add("missing_terminal")

    reaction = _span(at(reaction_start), at(reaction_end), anomalies)
    handling = _span(at(open_index), at(terminal), anomalies)
    lifetime = _span(_ms(value.appeared_at), at(terminal), anomalies)

    waiting: float | None
    if value.waiting is None:
        anomalies.add("waiting_unavailable")
        waiting = None
    elif open_index < 0:
        waiting = 0.0 if not value.waiting else None
    else:
        end = at(terminal)
        waiting = _union_seconds(
            value, normalized[open_index].at, end if end is not None else _ms(value.observed_at)
        )
    active = handling - waiting if handling is not None and waiting is not None else None

    if any(not item.trusted for item in normalized):
        anomalies.add("untrusted_clock")
    if version == 1:
        quality = "legacy"
    elif "non_monotonic" in anomalies:
        quality = "invalid"
    elif "untrusted_clock" in anomalies:
        quality = "estimated"
    else:
        quality = "verified"

    reaction_normative = (
        value.legacy_reaction_normative_s if policy is None else policy.reaction_normative_s
    )
    handling_normative = (
        value.legacy_handling_normative_s if policy is None else policy.handling_normative_s
    )
    # Автоматический штраф — только по достоверному измерению (I-TIME п.7).
    trusted = quality in ("verified", "legacy")

    def overdue(duration: float | None, normative: float) -> bool | None:
        return duration > normative if trusted and duration is not None else None

    # v3 сравнивает норматив с активной обработкой, v1/v2 — с полной (I-TIME v3, п.6).
    measure = active if version == 3 else handling
    return TimingResult(
        timing_version=version,  # type: ignore[arg-type]
        snapshot_id=value.snapshot_id,
        reaction_s=reaction,
        handling_s=handling,
        lifetime_s=lifetime,
        waiting_s=waiting,
        active_handling_s=active,
        reaction_normative_s=reaction_normative,
        handling_normative_s=handling_normative,
        reaction_overdue=overdue(reaction, reaction_normative),
        handling_overdue=overdue(measure, handling_normative),
        quality=quality,  # type: ignore[arg-type]
        anomalies=[item for item in ANOMALY_ORDER if item in anomalies],
        evidence=[item.evidence for item in normalized],
    )
