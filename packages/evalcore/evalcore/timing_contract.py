"""Стык I-TIME v2/v3. Расчёт реализует V-01; эти типы не меняют legacy-оценщик."""

from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class TimingPolicy:
    timing_version: Literal[2, 3]
    reaction_normative_s: float
    handling_normative_s: float
    waiting_policy: Literal["separate", "exclude_confirmed"]
    max_rtt_ms: float
    max_sample_age_ms: float
    max_buffer_delay_ms: float
    future_tolerance_ms: float


@dataclass(frozen=True)
class ClockSample:
    sample_id: str
    method: Literal["ws_midpoint_v2", "legacy_one_way"]
    client_sent_at: str
    server_at: str
    client_received_at: str | None
    offset_ms: float | None


@dataclass(frozen=True)
class TimingEvent:
    event_id: str
    kind: Literal["direct", "deliver", "open", "status", "redirect"]
    state: str | None
    client_ts: str
    server_ts: str
    clock: ClockSample | None


@dataclass(frozen=True)
class WaitingInterval:
    message_id: str
    started_at: str
    ended_at: str | None


@dataclass(frozen=True)
class TimingInput:
    snapshot_id: str
    policy: TimingPolicy | None
    legacy_reaction_normative_s: float
    legacy_handling_normative_s: float
    appeared_at: str
    observed_at: str
    events: list[TimingEvent]
    waiting: list[WaitingInterval] | None


@dataclass(frozen=True)
class TimingEvidence:
    event_id: str
    normalized_at: str
    source: Literal["corrected_client", "server_fallback", "legacy_client", "server"]
    reason: Literal[
        "verified",
        "missing_clock",
        "legacy_clock",
        "invalid_sample",
        "stale_sample",
        "future_event",
        "buffer_exceeded",
        "legacy",
        "server_event",
    ]


@dataclass(frozen=True)
class TimingResult:
    timing_version: Literal[1, 2, 3]
    snapshot_id: str
    reaction_s: float | None
    handling_s: float | None
    lifetime_s: float | None
    waiting_s: float | None
    active_handling_s: float | None
    reaction_normative_s: float
    handling_normative_s: float
    reaction_overdue: bool | None
    handling_overdue: bool | None
    quality: Literal["verified", "estimated", "invalid", "legacy"]
    anomalies: list[str]
    evidence: list[TimingEvidence]


class TimingCalculator(Protocol):
    def __call__(self, value: TimingInput) -> TimingResult:
        """v2: реакция deliver→первый open; v3: direct→первичный статус. См. I-TIME.md."""
        ...
