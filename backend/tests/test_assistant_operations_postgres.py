"""Integración del asistente con PostgreSQL local, migrado hasta head."""
import asyncio
import json
import os
import sys
import uuid
from datetime import timedelta

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import create_access_token
from app.db.base import utcnow
from app.db.session import get_db
from app.main import app
from app.models.assistant_operation import AssistantOperation
from app.models.task import Task
from app.models.user import User
from app.services import ai_gateway, assistant_operations

CHAT = "/api/v1/assistant/chat"
CONFIRM = "/api/v1/assistant/confirm"


@pytest_asyncio.fixture
async def postgres():
    raw = os.environ.get("ATLANTIUM_TEST_POSTGRES")
    if not raw:
        pytest.skip("Requiere PostgreSQL local migrado y ATLANTIUM_TEST_POSTGRES")
    url = make_url(raw)
    assert url.drivername == "postgresql+asyncpg"
    assert url.host in {"127.0.0.1", "::1"} and url.database == "atl108_test"
    engine = create_async_engine(url)
    sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    ids = []

    async def session():
        async with sessions() as db:
            yield db

    async def account():
        async with sessions.begin() as db:
            user = User(email=f"{uuid.uuid4()}@example.invalid", full_name="Test", hashed_password="unused")
            db.add(user)
            await db.flush()
            ids.append(user.id)
            return user.id, {"Authorization": f"Bearer {create_access_token(str(user.id))}"}

    app.dependency_overrides[get_db] = session
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            yield client, sessions, account
    finally:
        app.dependency_overrides.pop(get_db)
        async with sessions.begin() as db:
            await db.execute(delete(User).where(User.id.in_(ids)))
        await engine.dispose()


def turn(message):
    return {"request_id": str(uuid.uuid4()), "message": message}


def tool_call(tool, arguments):
    return {"tool_calls": [{"id": "call", "function": {"name": tool, "arguments": json.dumps(arguments)}}]}


async def count_tasks(sessions, user_id):
    async with sessions() as db:
        return await db.scalar(select(func.count()).select_from(Task).where(Task.user_id == user_id))


def simulate_model(monkeypatch, request):
    profile = ai_gateway.AiProfile("local", "http://model.invalid", "mock", "mock", "", 0, 5, True, 3)

    async def load(*_args):
        return profile

    async def outside_transaction(db, *args, **kwargs):
        assert not db.in_transaction()
        return await request(db, *args, **kwargs)

    monkeypatch.setattr(ai_gateway, "load_profile", load)
    monkeypatch.setattr(ai_gateway, "request_ai", outside_transaction)


@pytest.mark.asyncio
async def test_postgres_concurrent_send_replays_and_allows_new_identical_turn(postgres, monkeypatch):
    client, sessions, account = postgres
    uid, headers = await account()
    other, other_headers = await account()
    entered, release = asyncio.Event(), asyncio.Event()

    async def model(_db, _user, _source, _operation, request, **_):
        if request.messages[-1]["role"] == "tool":
            return {"content": "Guardado"}
        entered.set()
        await release.wait()
        return tool_call("create_task", {"title": "Misma tarea"})

    simulate_model(monkeypatch, model)
    payload = turn("Crea una tarea")
    first = asyncio.create_task(client.post(CHAT, json=payload, headers=headers))
    try:
        await asyncio.wait_for(entered.wait(), 8)
        duplicate = await client.post(CHAT, json=payload, headers=headers)
        assert duplicate.status_code == 409
    finally:
        release.set()
        original = await first
    assert original.status_code == 200
    assert (await client.post(CHAT, json=payload, headers=headers)).json() == original.json()
    assert (await client.post(CHAT, json={**payload, "message": "distinto"}, headers=headers)).status_code == 409
    assert (await client.post(CHAT, json=turn(payload["message"]), headers=headers)).status_code == 200
    assert (await client.post(CHAT, json=payload, headers=other_headers)).status_code == 200
    assert await count_tasks(sessions, uid) == 2
    assert await count_tasks(sessions, other) == 1
    assert (await client.post(CHAT, json={"message": "cliente anterior"}, headers=headers)).status_code == 428


@pytest.mark.asyncio
async def test_postgres_confirmation_is_owned_one_use_and_atomic(postgres, monkeypatch):
    client, sessions, account = postgres
    uid, headers = await account()
    _, other_headers = await account()

    async def model(_db, _user, _source, _operation, request, **_):
        if request.messages[-1]["role"] == "tool":
            return {"content": "Guardado"}
        if request.messages[-1]["content"] == "borrar":
            return tool_call("delete_task", {"task_title": "Temporal"})
        return tool_call("create_task", {"title": "Temporal"})

    simulate_model(monkeypatch, model)
    await client.post(CHAT, json=turn("crear"), headers=headers)
    draft = await client.post(CHAT, json=turn("borrar"), headers=headers)
    proposal = draft.json()["pending_action"]["proposal_id"]
    data = {"proposal_id": proposal, "approve": True}
    assert (await client.post(CONFIRM, json=data, headers=other_headers)).status_code == 404
    legacy = {"tool": "delete_task", "args": {"task_title": "Temporal"}, "approve": True}
    assert (await client.post(CONFIRM, json=legacy, headers=headers)).status_code == 422
    assert await count_tasks(sessions, uid) == 1
    from app.api.v1 import assistant

    execute_delete = assistant.ai_tools.delete_target

    async def lose_before_commit(*args, **kwargs):
        result = await execute_delete(*args, **kwargs)
        if kwargs.get("confirm"):
            raise ConnectionError("interrupted before commit")
        return result

    with monkeypatch.context() as test:
        test.setattr(assistant.ai_tools, "delete_target", lose_before_commit)
        with pytest.raises(ConnectionError):
            await client.post(CONFIRM, json=data, headers=headers)
    assert await count_tasks(sessions, uid) == 1
    first, second = await asyncio.gather(
        client.post(CONFIRM, json=data, headers=headers),
        client.post(CONFIRM, json=data, headers=headers),
    )
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert await count_tasks(sessions, uid) == 0
    assert (await client.post(CONFIRM, json={**data, "approve": False}, headers=headers)).status_code == 409

    await client.post(CHAT, json=turn("crear"), headers=headers)
    draft = await client.post(CHAT, json=turn("borrar"), headers=headers)
    data = {"proposal_id": draft.json()["pending_action"]["proposal_id"], "approve": True}

    def lose_after_commit(*_args):
        raise ConnectionError("interrupted after commit")

    with monkeypatch.context() as test:
        test.setattr(assistant, "notify", lose_after_commit)
        with pytest.raises(ConnectionError):
            await client.post(CONFIRM, json=data, headers=headers)
    assert await count_tasks(sessions, uid) == 0
    assert (await client.post(CONFIRM, json=data, headers=headers)).status_code == 200

    await client.post(CHAT, json=turn("crear"), headers=headers)
    draft = await client.post(CHAT, json=turn("borrar"), headers=headers)
    expired = {"proposal_id": draft.json()["pending_action"]["proposal_id"], "approve": True}
    with monkeypatch.context() as test:
        test.setattr(assistant_operations, "utcnow", lambda: utcnow() + timedelta(minutes=21))
        assert (await client.post(CONFIRM, json=expired, headers=headers)).status_code == 410
    assert (await client.post(CONFIRM, json=expired, headers=headers)).status_code == 410
    assert await count_tasks(sessions, uid) == 1

    await client.delete("/api/v1/assistant/messages", headers=headers)
    assert (await client.post(CONFIRM, json=data, headers=headers)).status_code == 410
    async with sessions.begin() as db:
        await db.execute(delete(User).where(User.id == uid))
        assert await db.scalar(
            select(func.count()).select_from(AssistantOperation).where(AssistantOperation.user_id == uid)
        ) == 0


_CRASH_WORKER = """
import asyncio
import json
import os
import sys
import httpx
from app.main import app
from app.services import ai_gateway, ai_service, ai_tools

committed = sys.argv[1] == "after"
handler = ai_tools._HANDLERS["create_task"]

async def load(*args):
    return ai_gateway.AiProfile("local", "http://model.invalid", "mock", "mock", "", 0, 5, True, 3)

async def interrupted_tool(*args):
    result = await handler(*args)
    if not committed:
        os._exit(17)
    return result

async def interrupted(db, user, *args, execute, **kwargs):
    await execute("create_task", {"title": "Interrupted task"})
    os._exit(17)

ai_gateway.load_profile = load
ai_service.generate_reply = interrupted
ai_tools._HANDLERS["create_task"] = interrupted_tool

async def run():
    payload, headers = json.loads(sys.stdin.read())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/v1/assistant/chat", json=payload, headers=headers)

asyncio.run(run())
"""


@pytest.mark.asyncio
@pytest.mark.parametrize("committed", [False, True])
async def test_postgres_interrupted_turn_recovers_committed_changes_only(postgres, monkeypatch, committed):
    _, sessions, account = postgres
    uid, headers = await account()
    payload = turn("Interrupción")
    url = os.environ["ATLANTIUM_TEST_POSTGRES"]
    child = await asyncio.create_subprocess_exec(
        sys.executable, "-c", _CRASH_WORKER, "after" if committed else "before",
        stdin=asyncio.subprocess.PIPE,
        env={**os.environ, "DATABASE_URL": url, "DATABASE_URL_SYNC": url.replace("+asyncpg", "+psycopg2", 1)},
    )
    try:
        await asyncio.wait_for(child.communicate(json.dumps([payload, headers]).encode()), 25)
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
    assert child.returncode == 17
    simulate_model(monkeypatch, None)
    async with sessions() as db:
        operation = await db.get(AssistantOperation, (uid, uuid.UUID(payload["request_id"])))
        assert operation.effects == (["create_task"] if committed else [])
    monkeypatch.setattr(assistant_operations, "utcnow", lambda: utcnow() + timedelta(minutes=16))
    # A separate HTTP session sees only committed data and never enters the model.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as next_client:
        replay = await next_client.post(CHAT, json=payload, headers=headers)
        assert replay.status_code == 200
        assert replay.json()["error_code"] == "ai_operation_interrupted"
        assert f"Cambios guardados: {int(committed)}" in replay.json()["reply"]
        monkeypatch.setattr(assistant_operations, "utcnow", lambda: utcnow() + timedelta(days=31))
        assert (await next_client.post(CHAT, json=payload, headers=headers)).status_code == 410
    assert await count_tasks(sessions, uid) == int(committed)
