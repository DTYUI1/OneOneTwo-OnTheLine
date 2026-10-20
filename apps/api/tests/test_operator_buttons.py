"""Контракт информационного события колокольчика без зависимости от БД."""

from app.operator.router import CallJournal


def test_senior_call_survives_journal_validation():
    event = {"t": 4, "action": "senior_called", "note": "позвал старшего"}
    journal = CallJournal.model_validate({"events": [event]})
    assert journal.model_dump(exclude_none=True)["events"] == [event]


def test_voice_recording_survives_journal_validation():
    event = {"t": 0, "action": "opening", "reply": "Алло!", "voice": "elevator_stuck/opening"}
    journal = CallJournal.model_validate({"events": [event]})
    assert journal.model_dump(exclude_none=True)["events"] == [event]
