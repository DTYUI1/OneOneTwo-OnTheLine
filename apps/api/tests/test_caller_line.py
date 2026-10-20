"""HQ-019 с БД: живой заявитель — реплики `caller_said` в журнале карточки и в `lines` оценки.

Звонок на номер заявителя ведёт окно телефона; сервер принимает реплику только из книг
заявителя и только в отвеченном звонке заявителю этой карточки. Реплика со сведением сюжета
(кроме неполного ответа растерянной) — в `EvalContext.lines` с моментом, когда прозвучала.
"""

from typing import Any
from uuid import UUID, uuid4

from app.api.evaluations.service import conversation_lines
from app.api.training.caller import caller_phrases
from app.core.models import Card

from .test_c04_completion import seed_training
from .test_final_scenarios import CALLER, HOUSEHOLD, WITH_CALLER, Shift, open_shift
from .test_lifecycle import run_db

ETA = "CALLER_CALM.tell_eta.animal_shaft.1"
# Неполный ответ растерянной: «пять? Десять?» — сведения не даёт.
ETA_FIRST = "CALLER_CONFUSED.tell_eta.animal_shaft.1"
ETA_AGAIN = "CALLER_CONFUSED.tell_eta.animal_shaft.2"


def caller_call(shift: Shift) -> str:
    call_id = str(uuid4())
    shift.send("call_dial", {"call_id": call_id, "phone_ext": CALLER["number"]})
    shift.send("call_answer", {"call_id": call_id})
    return call_id


def lines(shift: Shift) -> dict[str, Any]:
    async def load(db):
        card = await db.get(Card, UUID(shift.card_id))
        return await conversation_lines(db, card)

    return {item["text"]: item for item in run_db(shift.url, load)}


def test_caller_lines_go_to_journal_and_eval_lines(database_config, database_url, request):
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, HOUSEHOLD, WITH_CALLER)
    training = shift.client.get(f"/api/cards/{shift.card_id}/training").json()
    assert training["caller"] == {"plot": "animal_shaft", "character": "calm"}
    shift.open()
    call_id = caller_call(shift)
    for phrase in ("CALLER_CALM.answer.animal_shaft.1", ETA, ETA_FIRST, ETA_AGAIN):
        shift.send("caller_said", {"call_id": call_id, "phrase_id": phrase})
    shift.send("call_hangup", {"call_id": call_id})
    # Реплика пришла очередью после отбоя — всё равно прозвучала в этом звонке.
    shift.send("caller_said", {"call_id": call_id, "phrase_id": ETA})
    events = shift.client.get(f"/api/cards/{shift.card_id}/events").json()
    said = [item["payload"]["phrase_id"] for item in events if item["type"] == "caller_said"]
    assert said == ["CALLER_CALM.answer.animal_shaft.1", ETA, ETA_FIRST, ETA_AGAIN, ETA]
    heard = lines(shift)
    texts = caller_phrases()
    assert heard[texts[ETA]["text"]]["presented_at"] is not None
    assert heard[texts[ETA_AGAIN]["text"]]["planned"] is False
    # Без сведения (ответ на звонок) и неполный ответ в `lines` не идут.
    assert texts[ETA_FIRST]["text"] not in heard
    assert texts["CALLER_CALM.answer.animal_shaft.1"]["text"] not in heard


def test_caller_line_needs_caller_call_and_caller_phrase(database_config, database_url, request):
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, HOUSEHOLD, WITH_CALLER)
    shift.open()
    shift.send("caller_said", {"call_id": str(uuid4()), "phrase_id": ETA}, 404)
    head = str(uuid4())
    shift.send("call_dial", {"call_id": head, "phone_ext": "401"})
    shift.send("call_answer", {"call_id": head})
    # Руководитель — не заявитель: реплика заявителя в его звонке не звучит.
    shift.send("caller_said", {"call_id": head, "phrase_id": ETA}, 409)
    shift.send("call_hangup", {"call_id": head})
    call_id = str(uuid4())
    shift.send("call_dial", {"call_id": call_id, "phone_ext": CALLER["number"]})
    # До ответа заявитель ещё ничего не сказал.
    shift.send("caller_said", {"call_id": call_id, "phrase_id": ETA}, 409)
    shift.send("call_answer", {"call_id": call_id})
    shift.send(
        "caller_said", {"call_id": call_id, "phrase_id": "CALLER_CALM.tell_eta.animal_shaft.9"}, 422
    )
    shift.send("call_hangup", {"call_id": call_id})
