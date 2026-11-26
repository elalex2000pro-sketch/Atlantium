"""Idempotencia y límites de transacción del asistente.

Los turnos interrumpidos nunca se retoman. Las propuestas caducan a los 20
minutos y los resultados se pueden recuperar durante 30 días. El registro
mínimo se conserva hasta el borrado de la cuenta para impedir reejecuciones
tras caducar o borrar el historial.
"""
from __future__ import annotations

import hmac
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.core.config import settings
from app.db.base import utcnow
from app.models.assistant_message import AssistantMessage
from app.models.assistant_operation import AssistantOperation
from app.services import ai_tools
from app.services.realtime import notify

TURN_TTL = timedelta(minutes=15)
PROPOSAL_TTL = timedelta(minutes=20)
REPLAY_TTL = timedelta(days=30)
Operation = AssistantOperation


def fingerprint(payload) -> str:
    # El HMAC impide comprobar por diccionario el contenido de un prompt desde la BD.
    mac = hmac.new(settings.secret_key.encode(), b"assistant-operation:v1:", "sha256")
    mac.update(payload.model_dump_json(exclude={"request_id"}).encode())
    return mac.hexdigest()


def age(timestamp: datetime) -> timedelta:
    return utcnow() - (timestamp if timestamp.tzinfo is not None else timestamp.replace(tzinfo=timezone.utc))


async def reserve(db, user_id: uuid.UUID, request_id: uuid.UUID, digest: str):
    insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
    created = await db.scalar(
        insert(Operation).values(
            user_id=user_id, request_id=request_id, fingerprint=digest,
            state="running", started_at=utcnow(), effects=[],
        ).on_conflict_do_nothing(index_elements=["user_id", "request_id"]).returning(Operation)
    )
    if created is not None:
        return created, True
    existing = await lock(db, user_id, request_id=request_id)
    if not hmac.compare_digest(existing.fingerprint, digest):
        raise HTTPException(409, "El identificador ya corresponde a otro envío.")
    return existing, False


async def find(db, user_id: uuid.UUID, *, request_id=None, proposal_id=None) -> Operation:
    """Consulta de solo lectura de una operación perteneciente al usuario."""
    key = Operation.request_id == request_id if request_id is not None else Operation.proposal_id == proposal_id
    operation = await db.scalar(select(Operation).where(Operation.user_id == user_id, key))
    if operation is None:
        raise HTTPException(404, "No se encontró la operación.")
    return operation


async def lock(db, user_id: uuid.UUID, *, request_id=None, proposal_id=None) -> Operation:
    key = Operation.request_id == request_id if request_id is not None else Operation.proposal_id == proposal_id
    filters = (Operation.user_id == user_id, key)
    if db.get_bind().dialect.name == "sqlite":
        # SQLite no implementa SELECT FOR UPDATE.
        statement = update(Operation).where(*filters).values(state=Operation.state).returning(Operation)
    else:
        statement = select(Operation).where(*filters).with_for_update()
    operation = await db.scalar(statement.execution_options(populate_existing=True))
    if operation is None:
        raise HTTPException(404, "No se encontró la operación.")
    return operation


async def active(db, user_id: uuid.UUID, request_id: uuid.UUID) -> Operation:
    operation = await lock(db, user_id, request_id=request_id)
    if operation.state != "running" or age(operation.started_at) >= TURN_TTL:
        await db.rollback()
        raise HTTPException(409, "El turno ya no está activo. Reenvía la misma solicitud para consultar su estado.")
    return operation


async def execute(db, user, request_id: uuid.UUID, name: str, args: dict):
    user_id = user.id
    operation = await active(db, user_id, request_id)
    # A failed tool must roll back its writes without invalidating the caller's
    # authenticated user or losing previously committed steps.
    async with db.begin_nested():
        result, events = await ai_tools.execute_tool(db, user, name, args, commit=False)
    if events:
        operation.effects = [*operation.effects, name]
    await db.commit()
    for event in set(events):
        notify(user_id, event, {"action": "changed", "by": "ai"})
    return result, events


async def owned_message(db, user_id: uuid.UUID, message_id: uuid.UUID | None):
    if message_id is None:
        return None
    return await db.scalar(
        select(AssistantMessage).where(AssistantMessage.id == message_id, AssistantMessage.user_id == user_id)
    )
