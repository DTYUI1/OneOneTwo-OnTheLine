"""MVP-STUB капитан T-007/T-008: синтетический backend в памяти, один процесс.

Контрактные примеры позволяют разрабатывать зоны до появления БД. Это не симулятор:
оценки и отчёты — примеры, состояние теряется при перезапуске. Prism доступен отдельно.
"""

import asyncio
import copy
import json
import secrets
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import jwt
from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.api.c01 import pending, reject_extensions, validate_pending
from app.core.config import ROOT, settings


def now() -> str:
    return datetime.now(UTC).isoformat()


class MockBackend:
    def __init__(self, spec: dict) -> None:
        self.spec = spec
        self.schemas = spec["components"]["schemas"]
        self.users = json.loads((ROOT / "data/seed/demo_users.json").read_text(encoding="utf-8"))
        # Корзина и копии C-07: мок копий не делает — запрос остаётся «ожидает».
        self.backups: list[dict] = []
        self.trash_reasons: dict[str, str] = {}
        services = spec["paths"]["/services"]["get"]["responses"]["200"]["content"]
        self.services = copy.deepcopy(services["application/json"]["example"])
        self.secret = secrets.token_urlsafe(32)
        self.sessions: dict[str, dict] = {}
        self.cards = {self.example("Card")["id"]: self.example("Card")}
        self.lesson = self.example("Session")
        self.events: dict[str, list[dict]] = {card_id: [] for card_id in self.cards}
        self.receipts: dict[tuple[str, str], tuple[dict, dict]] = {}
        self.sockets: dict[WebSocket, dict] = {}
        self.call = self.example("Call")
        self.lock = asyncio.Lock()

    def example(self, name: str) -> Any:
        return copy.deepcopy(self.schemas[name]["examples"][0])

    def validate(self, schema: dict, body: Any) -> None:
        document = {"$schema": "https://json-schema.org/draft/2020-12/schema", **self.spec}
        registry = Registry().with_resource("urn:contract", Resource.from_contents(document))
        validator = (
            Draft202012Validator(
                {"$ref": "urn:contract", **schema},
                registry=registry,
                format_checker=FormatChecker(),
            )
            if "$ref" not in schema
            else Draft202012Validator(
                {"$ref": "urn:contract" + schema["$ref"]},
                registry=registry,
                format_checker=FormatChecker(),
            )
        )
        errors = list(validator.iter_errors(body))
        if errors:
            raise HTTPException(422, "Запрос не соответствует контракту.")

    def authenticate(self, token: str | None) -> dict:
        try:
            payload = jwt.decode(token or "", self.secret, algorithms=["HS256"])
            return self.sessions[payload["sid"]]
        except (jwt.InvalidTokenError, KeyError) as exc:
            raise HTTPException(401, "Войдите в систему.") from exc

    def visible_cards(self, user: dict) -> list[dict]:
        return [
            c
            for c in self.cards.values()
            if user["role"] != "trainee" or c["trainee_id"] == user["id"]
        ]

    async def handle(self, request: Request, operation: dict) -> Response:
        op = operation["operationId"]
        user = None
        if operation["security"]:
            session = self.authenticate(request.cookies.get("session"))
            user = session["user"]
            if user["role"] not in operation["x-roles"]:
                raise HTTPException(403, "Недостаточно прав.")
            if request.method != "GET":
                token = request.headers.get("X-CSRF-Token", "")
                if not token or token != request.cookies.get("csrf") or token != session["csrf"]:
                    raise HTTPException(403, "Неверный CSRF-токен.")
        body = None
        if operation.get("x-implementation-status") == "contract-ready":
            await validate_pending(request, operation)
            pending(operation["x-owner"])
        if "requestBody" in operation and (
            operation["requestBody"].get("required", False) or await request.body()
        ):
            content = operation["requestBody"]["content"]
            if "application/json" not in content:
                raise HTTPException(
                    501, "Загрузка аудио реализуется в T-008; контракт уже закреплён."
                )
            body = await request.json()
            self.validate(content["application/json"]["schema"], body)
        reject_extensions(op, body, user["role"] if user else "")
        if op == "login":
            assert body is not None
            account = next((u for u in self.users if u["login"] == body["login"]), None)
            if (
                account is None
                or not account.get("is_active", True)
                or not secrets.compare_digest(
                    body["password"].encode("utf-8"), settings.demo_password.encode("utf-8")
                )
            ):
                raise HTTPException(401, "Неверный логин или пароль.")
            sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.sessions[sid] = {"user": account, "csrf": csrf}
            token = jwt.encode(
                {"sid": sid, "exp": int(datetime.now(UTC).timestamp()) + 28800},
                self.secret,
                algorithm="HS256",
            )
            response = JSONResponse(account)
            response.set_cookie(
                "session",
                token,
                httponly=True,
                secure=settings.cookie_secure,
                samesite="strict",
                max_age=28800,
            )
            response.set_cookie(
                "csrf", csrf, secure=settings.cookie_secure, samesite="strict", max_age=28800
            )
            return response
        if op == "me":
            return JSONResponse(user)
        if op == "logout":
            token = jwt.decode(request.cookies["session"], self.secret, algorithms=["HS256"])
            del self.sessions[token["sid"]]
            for socket in list(self.sockets):
                if socket.cookies.get("session") == request.cookies["session"]:
                    await self.disconnect(socket)
            response = JSONResponse(user)
            response.delete_cookie("session")
            response.delete_cookie("csrf")
            return response
        if op == "health":
            health = self.example("Health")
            health["mode"] = settings.api_mode
            return JSONResponse(health)
        assert user is not None
        if op == "listCards":
            return JSONResponse(self.visible_cards(user))
        if op in {"getCard", "postEvent", "listEvents", "listCalls"}:
            card = self.cards.get(request.path_params["id"])
            if card is None or (user["role"] == "trainee" and card["trainee_id"] != user["id"]):
                raise HTTPException(404, "Карточка не найдена.")
            if op == "getCard":
                return JSONResponse(card)
            if op == "listEvents":
                return JSONResponse(self.events[card["id"]])
            if op == "listCalls":
                return JSONResponse([self.call] if self.call["card_id"] == card["id"] else [])
            assert body is not None
            return JSONResponse(await self.post_event(card, body, user))
        if op in {"listEvaluations", "getEvaluation", "getCall"}:
            result = self.call if op == "getCall" else self.example("Evaluation")
            if not any(c["id"] == result["card_id"] for c in self.visible_cards(user)):
                if op == "listEvaluations":
                    return JSONResponse([])
                raise HTTPException(404, "Результат не найден.")
            if "id" in request.path_params and request.path_params["id"] != result["id"]:
                raise HTTPException(404, "Результат не найден.")
            return JSONResponse([result] if op == "listEvaluations" else result)
        if op in {"listSessions", "getSession", "startSession", "finishSession"}:
            if "id" in request.path_params and request.path_params["id"] != self.lesson["id"]:
                raise HTTPException(404, "Занятие не найдено.")
            if user["role"] == "trainee":
                if not any(p["user_id"] == user["id"] for p in self.lesson["participants"]):
                    if op == "listSessions":
                        return JSONResponse([])
                    raise HTTPException(404, "Занятие не найдено.")
                visible_lesson = {
                    **self.lesson,
                    "participants": [
                        p for p in self.lesson["participants"] if p["user_id"] == user["id"]
                    ],
                }
            else:
                visible_lesson = self.lesson
            if op in {"startSession", "finishSession"}:
                self.lesson["status"] = "running" if op == "startSession" else "finished"
                await self.broadcast(
                    "session.started" if op == "startSession" else "session.finished", self.lesson
                )
            return JSONResponse([visible_lesson] if op == "listSessions" else visible_lesson)
        if op == "listUsers":
            return JSONResponse(self.users)
        if op == "listServices":
            return JSONResponse(self.services)
        if op == "updateService":
            assert body is not None
            service = next((s for s in self.services if s["id"] == request.path_params["id"]), None)
            if service is None:
                raise HTTPException(404, "Служба не найдена.")
            service["is_active"] = body["is_active"]
            return JSONResponse(service)
        if op in {"createUser", "updateUser", "resetUserPassword", "trashUser", "restoreUser"}:
            return await self.manage_user(op, request, body)
        if op == "listTrash":
            items = [
                {
                    "kind": "user",
                    "id": u["id"],
                    "title": u["full_name"],
                    "login": u["login"],
                    "role": u["role"],
                    "reason": self.trash_reasons.get(u["id"]),
                    "deleted_at": u["deleted_at"],
                    "deleted_by": None,
                    "purged_at": None,
                    "state": "waiting_backup",
                }
                for u in self.users
                if u.get("deleted_at")
            ]
            return JSONResponse({"last_backup_at": None, "items": items})
        if op == "listBackups":
            return JSONResponse(self.backups[::-1])
        if op == "requestBackup":
            if any(b["status"] == "pending" for b in self.backups):
                raise HTTPException(409, "Копия уже запрошена или идёт.")
            assert user is not None
            run = {
                "id": str(uuid4()),
                "status": "pending",
                "requested_by": user["id"],
                "requested_at": now(),
                "started_at": None,
                "finished_at": None,
                "name": None,
                "error": None,
            }
            self.backups.append(run)
            return JSONResponse(run, status_code=202)
        if op == "exportSessionCsv":
            return Response(
                "\ufeffФИО;АРМ;Балл\r\nОбучаемый 01;1;1\r\n", media_type="text/csv; charset=utf-8"
            )
        success = next(code for code in operation["responses"] if code.startswith("2"))
        # MVP-STUB капитан: оставшиеся методы возвращают именно примеры контракта.
        example = operation["responses"][success]["content"]["application/json"]["example"]
        return JSONResponse(example, status_code=int(success), headers={"X-Mock-Response": "true"})

    async def manage_user(self, op: str, request: Request, body: Any) -> JSONResponse:
        """Учётные записи C-07 в памяти мока: пароль не хранится, вход — по DEMO_PASSWORD."""
        assert body is not None or op == "restoreUser"
        if op == "createUser":
            if any(u["login"] == body["login"] for u in self.users):
                raise HTTPException(409, "Такой логин уже есть.")
            account = {k: v for k, v in body.items() if k != "password"}
            account = {"id": str(uuid4()), **account, "is_active": True}
            self.users.append(account)
            return JSONResponse(account, status_code=201)
        found = next((u for u in self.users if u["id"] == request.path_params["id"]), None)
        if found is None:
            raise HTTPException(404, "Пользователь не найден.")
        if op in {"updateUser", "resetUserPassword"} and found.get("deleted_at"):
            raise HTTPException(409, "Учётная запись в корзине.")
        if op == "trashUser":
            found.update(is_active=False, deleted_at=now())
            self.trash_reasons[found["id"]] = body["reason"].strip()
            await self.drop_sockets(found["id"])
            return JSONResponse(found)
        if op == "restoreUser":
            found["deleted_at"] = None
            self.trash_reasons.pop(found["id"], None)
            return JSONResponse(found)
        if op == "updateUser":
            found.update(body)
            if not found["is_active"]:
                await self.drop_sockets(found["id"])
        return JSONResponse(found)

    async def drop_sockets(self, user_id: str) -> None:
        for socket, owner in list(self.sockets.items()):
            if owner["id"] == user_id:
                await self.disconnect(socket)

    async def post_event(self, card: dict, body: dict, user: dict) -> dict:
        async with self.lock:
            key = (user["id"], body["client_event_id"])
            if key in self.receipts:
                previous, receipt = self.receipts[key]
                if previous != {"card_id": card["id"], **body}:
                    raise HTTPException(
                        409, "client_event_id уже использован для другого действия."
                    )
                return {**receipt, "duplicate": True}
            kind, payload, timestamp = body["type"], body["payload"], now()
            if kind == "deliver" and card["delivered_at"] is None:
                card["delivered_at"] = timestamp
                card["state"] = "received"
            elif kind == "open" and card["opened_at"] is None:
                card["opened_at"] = timestamp
            elif kind == "field_change":
                card["current"][payload["field"]] = payload["value"]
            elif kind == "comment":
                card["current"]["comment"] = payload["comment"]
            elif kind in {"status_change", "redirect"}:
                card["state"] = payload.get("state", "redirected")
                card["current"]["comment"] = payload["comment"]
                if card["state"] in {"completed", "refused", "redirected"}:
                    card["closed_at"] = timestamp
            elif kind.startswith("call_"):
                self.call.update(
                    id=payload["call_id"],
                    card_id=card["id"],
                    state={
                        "call_dial": "dialing",
                        "call_answer": "talking",
                        "call_hangup": "ended",
                    }[kind],
                )
                if kind == "call_dial":
                    self.call["phone_ext"] = payload["phone_ext"]
                await self.broadcast("call.state", self.call)
            event = {
                "id": str(uuid4()),
                "card_id": card["id"],
                "actor_id": user["id"],
                **body,
                "server_ts": timestamp,
                "clock_offset_ms": 0,
            }
            self.events[card["id"]].append(event)
            receipt = {
                "client_event_id": body["client_event_id"],
                "server_ts": timestamp,
                "duplicate": False,
                "card": copy.deepcopy(card),
            }
            self.receipts[key] = ({"card_id": card["id"], **copy.deepcopy(body)}, receipt)
            await self.broadcast("card.updated", card)
            return receipt

    async def disconnect(self, socket: WebSocket) -> None:
        self.sockets.pop(socket, None)
        try:
            await socket.close(code=1000)
        except (WebSocketDisconnect, RuntimeError):
            # Reload/закрытие вкладки могут завершить сокет раньше logout/shutdown.
            # Сессия уже отозвана; повторное закрытие не должно превращать выход в 500.
            pass

    async def send(self, socket: WebSocket, kind: str, payload: dict) -> None:
        await socket.send_json(
            {
                "schema_version": 1,
                "event_id": str(uuid4()),
                "server_ts": now(),
                "type": kind,
                "payload": payload,
            }
        )

    async def broadcast(self, kind: str, payload: dict) -> None:
        for socket, user in list(self.sockets.items()):
            if user["role"] == "trainee":
                if kind.startswith(("card.", "call.")):
                    card_id = payload["id"] if kind.startswith("card.") else payload["card_id"]
                    if not any(c["id"] == card_id for c in self.visible_cards(user)):
                        continue
                if kind.startswith("session.") and not any(
                    p["user_id"] == user["id"] for p in payload["participants"]
                ):
                    continue
            visible_payload = payload
            if kind.startswith("session.") and user["role"] == "trainee":
                visible_payload = {
                    **payload,
                    "participants": [
                        p for p in payload["participants"] if p["user_id"] == user["id"]
                    ],
                }
            try:
                await self.send(socket, kind, visible_payload)
            except (WebSocketDisconnect, RuntimeError):
                self.sockets.pop(socket, None)

    async def websocket(self, socket: WebSocket) -> None:
        origin = socket.headers.get("origin")
        if origin and urlsplit(origin).netloc != socket.headers.get("host"):
            await socket.close(code=1008)
            return
        try:
            user = self.authenticate(socket.cookies.get("session"))["user"]
        except HTTPException:
            await socket.close(code=1008)
            return
        await socket.accept()
        self.sockets[socket] = user
        try:
            await self.send(socket, "presence", {"user_id": user["id"], "online": True})
            await self.send(
                socket,
                "snapshot",
                {"cards": self.visible_cards(user), "sessions": [], "evaluations": []},
            )
            while True:
                message = await socket.receive_json()
                self.validate({"$ref": "#/components/schemas/WsClientEvent"}, message)
                if message["type"] == "clock.ping.v2":
                    # MVP-STUB капитан C-02: новый sample_id нельзя молча отбросить.
                    await socket.close(code=4400)
                    break
                await self.send(socket, "clock.pong", {"client_ts": message["client_ts"]})
        except (WebSocketDisconnect, RuntimeError):
            pass
        except (HTTPException, json.JSONDecodeError):
            await socket.close(code=1008)
        finally:
            self.sockets.pop(socket, None)
