"""Проверка вводной бригаде (GP-05): что поймёт бригада из фразы — до отправки события.

Голос и части проверяются одним правилом (`evalcore.briefing`): браузер присылает
распознанную фразу (`POST /calls/{id}/voice-reply` без `delivery_id`) или фразу, собранную по
частям, и узнаёт, что бригада ответит. Полную вводную браузер отправляет событием
`brigade_briefing` — сервер проверяет фразу снова тем же правилом и только тогда отправляет
бригаду. Запрос ничего не сохраняет.
"""

from uuid import UUID

from fastapi import HTTPException, Request

from app.api.briefing import schemas
from app.api.cards.service import get_call_row, get_card_row
from app.api.training import briefing
from app.api.training.scenario_events import card_events_plan


async def check_briefing(
    request: Request, call_id: UUID, body: schemas.BriefingCheckInput
) -> schemas.BriefingCheck:
    request.state.entity = "call_briefing"
    request.state.entity_id = str(call_id)
    db = request.state.db
    call = await get_call_row(request, call_id)
    card = (await get_card_row(request, call.card_id))["Card"]
    await briefing.briefing_call(db, card, call.id)
    scenario = await briefing.card_scenario(db, card)
    if scenario is None:
        raise HTTPException(404, "Звонок не найден.")
    result = await briefing.check(db, scenario, body.text)
    _, events = await card_events_plan(db, card)
    return schemas.BriefingCheck(
        address=result.address,  # type: ignore[arg-type]
        heard_address=result.heard_address,
        incident=result.incident,
        complete=result.complete,
        readback=briefing.readback(
            result, briefing.has_readback_trap(events), scenario.target_service_id
        ),
        ask_again=briefing.ask_again(result, scenario.target_service_id),
    )
