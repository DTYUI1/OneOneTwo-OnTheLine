from fastapi import Request

from app.api.warmups import repo, schemas
from app.core.models import User, WarmupResult


def serialize(result: WarmupResult, trainee: User) -> schemas.WarmupResult:
    return schemas.WarmupResult.model_validate(
        {
            "id": result.id,
            "trainee_id": result.trainee_id,
            "trainee_name": trainee.full_name,
            "kind": result.kind,
            "correct": result.correct,
            "total": result.total,
            "duration_ms": result.duration_ms,
            "mistakes": result.mistakes,
            "created_at": result.created_at,
        }
    )


async def create(request: Request, body: schemas.WarmupResultInput) -> schemas.WarmupResult:
    db = request.state.db
    user: User = request.state.user
    result = WarmupResult(
        trainee_id=user.id,
        kind=body.kind,
        correct=body.correct,
        total=body.total,
        duration_ms=body.duration_ms,
        mistakes=list(body.mistakes),
    )
    db.add(result)
    await db.flush()
    await db.refresh(result)
    request.state.entity = "warmup_result"
    request.state.entity_id = str(result.id)
    request.state.audit_after = {"kind": result.kind, "correct": result.correct}
    return serialize(result, user)


async def list_results(request: Request) -> list[schemas.WarmupResult]:
    user: User = request.state.user
    # Обучаемый видит только свои результаты, преподаватель — всех обучаемых.
    trainee_id = user.id if user.role == "trainee" else None
    return [
        serialize(result, trainee)
        for result, trainee in await repo.latest(request.state.db, trainee_id)
    ]
