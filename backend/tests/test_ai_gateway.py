"""Cobertura del transporte único y de las credenciales de cada proveedor."""
import asyncio
import json
import uuid
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.core import crypto
from app.core.config import settings
from app.db.session import get_db
from app.models.user import User
from app.models.user_ai_key import UserAiKey
from app.services import ai_gateway
from app.services.ai_errors import AiRequestRejected
from test_chat_flow import account
from test_peer_classwork import client


PROVIDERS = ["local", "gemini", "openai", "claude", "openrouter", "custom"]
OPERATIONS = ["texto", "imagen", "audio"]


def use_transport(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **options: original(
        transport=httpx.MockTransport(handler), **options,
    ))


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", PROVIDERS)
@pytest.mark.parametrize("operation", OPERATIONS)
async def test_gateway_covers_providers_and_operations(monkeypatch, provider, operation):
    monkeypatch.setattr(settings, "environment", "test")
    monkeypatch.setattr(settings, "ai_api_key", "")
    monkeypatch.setattr(settings, "ai_transcribe_model", "whisper-1")
    user = SimpleNamespace(id=uuid.uuid4(), ai_provider=provider, ai_model="simulado",
                           ai_base_url="http://hostname.invalid/v1")
    db = SimpleNamespace(scalar=AsyncMock(return_value=crypto.encrypt("clave-personal-simulada")))
    order = []

    async def check(*args):
        assert args == (user, "asistente", "clave_del_alumno")
        order.append("check")

    async def record(*args):
        assert args == (user, "asistente", "clave_del_alumno")
        order.append("record")

    monkeypatch.setattr(ai_gateway, "check_quota", check)
    monkeypatch.setattr(ai_gateway, "record_usage", record)
    native = provider == "gemini" and operation == "imagen"

    def handle(request):
        order.append("post")
        if native:
            assert request.headers["x-goog-api-key"] == "clave-personal-simulada"
            assert request.url.path.endswith(":generateContent")
            assert "inlineData" in json.loads(request.content)["contents"][0]["parts"][0]
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "listo"}]}}]})
        authorization = None if provider == "local" else "Bearer clave-personal-simulada"
        assert request.headers.get("Authorization") == authorization
        if operation == "audio":
            assert request.url.path.endswith("/audio/transcriptions")
            assert b"audio simulado" in request.content
            assert (b"openai/whisper-1" in request.content) == (provider == "openrouter")
            return httpx.Response(200, json={"text": "listo"})
        assert request.url.path.endswith("/chat/completions")
        assert json.loads(request.content)["messages"] == messages
        return httpx.Response(200, json={"choices": [{"message": {"content": "listo"}}]})

    use_transport(monkeypatch, handle)
    messages = [{"role": "user", "content": "pregunta simulada"}]
    if operation == "imagen":
        messages[0]["content"] = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}]
    payload = ai_gateway.ChatRequest(messages, use_vision_model=operation == "imagen")
    expected = {"content": "listo"}
    if native:
        payload = ai_gateway.GeminiRequest("sistema", [
            {"role": "user", "parts": [{"inlineData": {"mimeType": "image/png", "data": "AA=="}}]},
        ])
        expected = {"parts": [{"text": "listo"}]}
    if operation == "audio":
        payload = ai_gateway.AudioRequest("grabacion.mp3", b"audio simulado", "audio/mpeg")
        expected = {"text": "listo"}
        if provider in {"claude", "gemini"}:
            with pytest.raises(AiRequestRejected) as failure:
                await ai_gateway.request_ai(db, user, "asistente", operation, payload)
            assert "no admite la transcripción" in failure.value.detail
            assert order == []
            return
    assert await ai_gateway.request_ai(db, user, "asistente", operation, payload) == expected
    assert order == ["check", "post", "record"]


@pytest.mark.asyncio
async def test_gateway_does_not_remove_tools_after_400(monkeypatch):
    profile = ai_gateway.AiProfile("local", "http://ollama.invalid/v1", "test", "test", "", 0, 5, True, 2)
    user = SimpleNamespace(id=uuid.uuid4())
    order = []

    async def check(*_):
        order.append("check")

    async def record(*_):
        order.append("record")

    def handle(request):
        order.append("post")
        assert "tools" in json.loads(request.content)
        return httpx.Response(400)

    use_transport(monkeypatch, handle)
    monkeypatch.setattr(ai_gateway, "check_quota", check)
    monkeypatch.setattr(ai_gateway, "record_usage", record)
    payload = ai_gateway.ChatRequest([], tools=[{"type": "function"}])
    with pytest.raises(httpx.HTTPStatusError):
        await ai_gateway.request_ai(None, user, "notas", "texto", payload, profile=profile)
    assert order == ["check", "post", "record"]


@pytest.mark.asyncio
async def test_quota_rejection_prevents_network_and_accounting(monkeypatch):
    profile = ai_gateway.AiProfile("local", "http://ollama.invalid/v1", "test", "test", "", 0, 5, False, 1)
    quota = AsyncMock(side_effect=AiRequestRejected(status_code=429, detail="Cuota de prueba"))
    usage = AsyncMock()
    monkeypatch.setattr(ai_gateway, "check_quota", quota)
    monkeypatch.setattr(ai_gateway, "record_usage", usage)
    use_transport(monkeypatch, lambda request: pytest.fail("No debe conectar"))
    user = SimpleNamespace(id=uuid.uuid4())
    with pytest.raises(AiRequestRejected) as failure:
        await ai_gateway.request_ai(None, user, "libros", "texto", ai_gateway.ChatRequest([]), profile=profile)
    assert failure.value.headers["X-AI-Error-Code"] == "ai_local_quota"
    quota.assert_awaited_once_with(user, "libros", "clave_del_alumno")
    usage.assert_not_awaited()


def gemini_profile():
    return ai_gateway.AiProfile("gemini", "https://gemini.invalid/openai", "test", "test", "secret", 0, 5, True, 3)


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "hint", "wait"), [
    (429, "1", 1), (429, None, None), (429, "120", None),
    (503, None, 0.5), (503, "0", 0), (503, "invalid", None),
    (503, "Wed, 21 Oct 2015 07:28:00 GMT", 0), (400, "1", None),
])
async def test_gemini_retry_is_bounded_and_preserves_tools(monkeypatch, status, hint, wait):
    bodies = []

    def handle(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(status, headers={"Retry-After": hint} if hint is not None else {})

    use_transport(monkeypatch, handle)
    sleep = AsyncMock()
    check = AsyncMock()
    record = AsyncMock()
    monkeypatch.setattr(ai_gateway.asyncio, "sleep", sleep)
    monkeypatch.setattr(ai_gateway, "check_quota", check)
    monkeypatch.setattr(ai_gateway, "record_usage", record)
    payload = ai_gateway.ChatRequest([], tools=[{"type": "function"}])
    with pytest.raises(httpx.HTTPStatusError):
        await ai_gateway.request_ai(None, None, "asistente", "texto", payload, profile=gemini_profile())
    attempts = 1 if wait is None else 2
    assert len(bodies) == check.await_count == record.await_count == attempts
    assert all(body["tools"] == payload.tools and body == bodies[0] for body in bodies)
    if wait is None:
        sleep.assert_not_awaited()
    else:
        sleep.assert_awaited_once_with(wait)


@pytest.mark.asyncio
@pytest.mark.parametrize(("native", "body", "code"), [
    (True, {"promptFeedback": {"blockReason": "SAFETY"}}, "ai_blocked_response"),
    (True, {"candidates": [{"finishReason": "RECITATION", "content": {"parts": [{"text": "private"}]}}]}, "ai_blocked_response"),
    (True, {"candidates": [{"content": {"parts": [{"text": "private", "thought": True}]}}]}, "ai_empty_response"),
    (False, {"choices": [{"finish_reason": "content_filter"}]}, "ai_blocked_response"),
    (False, {"choices": [{"message": {"content": "  "}}]}, "ai_empty_response"),
    (False, [], "ai_empty_response"),
])
async def test_success_status_can_contain_a_blocked_or_empty_reply(monkeypatch, native, body, code):
    use_transport(monkeypatch, lambda request: httpx.Response(200, json=body))
    payload = ai_gateway.GeminiRequest("sistema", []) if native else ai_gateway.ChatRequest([])
    with pytest.raises(ai_gateway.GeminiResponseError) as failure:
        await ai_gateway.request_ai(None, None, "asistente", "texto", payload, profile=gemini_profile())
    assert failure.value.code == code
    assert "private" not in str(failure.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("host", [
    "localhost", "127.0.0.2", "10.1.2.3", "172.31.1.2", "192.168.1.2", "169.254.1.2",
    "[::1]", "[::ffff:10.1.2.3]", "privado.example",
])
async def test_hosted_custom_does_not_send_to_private_destination(monkeypatch, host):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=[
        (2, 1, 6, "", ("8.8.8.8", 443)),
        (2, 1, 6, "", ("10.1.2.3", 443)),
    ]))
    use_transport(monkeypatch, lambda request: pytest.fail("No debe conectar"))
    profile = ai_gateway.AiProfile("custom", f"https://{host}/v1", "test", "test", "simulada", 0, 5, False, 1)
    with pytest.raises(AiRequestRejected) as failure:
        await ai_gateway.request_ai(None, None, "studio", "texto", ai_gateway.ChatRequest([]), profile=profile)
    assert "pública y usar HTTPS" in failure.value.detail


@pytest.mark.asyncio
async def test_hosted_custom_uses_checked_address_and_does_not_follow_redirects(monkeypatch):
    monkeypatch.setattr(settings, "environment", "staging")
    dns = AsyncMock(return_value=[(2, 1, 6, "", ("8.8.8.8", 443))])
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", dns)
    requests = []

    def handle(request):
        requests.append(request)
        assert request.url.host == "8.8.8.8"
        assert request.headers["Host"] == "motor.example"
        assert request.extensions["sni_hostname"] == "motor.example"
        return httpx.Response(307, headers={"Location": "https://otro.example/"})

    use_transport(monkeypatch, handle)
    profile = ai_gateway.AiProfile("custom", "https://motor.example/v1", "test", "test", "simulada", 0, 5, False, 1)
    with pytest.raises(httpx.HTTPStatusError):
        await ai_gateway.request_ai(None, None, "studio", "texto", ai_gateway.ChatRequest([]), profile=profile)
    assert len(requests) == dns.await_count == 1
    with pytest.raises(AiRequestRejected):
        await ai_gateway.validate_custom_url("http://motor.example/v1")
    assert dns.await_count == 1


def test_profile_keeps_credentials_by_provider_and_deletes_only_the_requested_key(client, monkeypatch):
    headers, account_data, _ = account(client, "clave")
    other, _, _ = account(client, "otra-clave")
    url = "/api/v1/assistant/profile"

    def put(provider, key=None, auth=headers):
        response = client.put(url, headers=auth, json={"provider": provider, "api_key": key})
        assert response.status_code == 200, response.text
        assert key is None or key not in response.text
        return response.json()

    assert put("gemini", "clave-gemini-ficticia")["has_api_key"]
    assert put("openai", "clave-openai-ficticia")["providers_with_key"] == ["gemini", "openai"]
    assert put("gemini")["has_api_key"]
    assert put("gemini", "otra-clave-gemini-ficticia", other)["has_api_key"]

    async def seed_legacy_copy():
        async for db in client.app.dependency_overrides[get_db]():
            user = await db.get(User, uuid.UUID(account_data["id"]))
            user.ai_api_key_encrypted = await db.scalar(sa.select(UserAiKey.encrypted_key).where(
                UserAiKey.user_id == user.id, UserAiKey.provider == "gemini",
            ))
            await db.commit()

    asyncio.run(seed_legacy_copy())
    assert put("openai")["has_api_key"]
    requests = []

    def transcribe(request):
        requests.append(request.headers["Authorization"])
        return httpx.Response(200, json={"text": "Simulación"})

    use_transport(monkeypatch, transcribe)
    audio = client.post(
        "/api/v1/transcribe", headers=headers, files={"file": ("clase.mp3", b"audio", "audio/mpeg")},
    )
    assert audio.status_code == 200
    assert requests == ["Bearer clave-openai-ficticia"]
    deleted = client.delete(url + "/keys/gemini", headers=headers)
    assert deleted.status_code == 200
    assert deleted.json()["providers_with_key"] == ["openai"]
    assert deleted.json()["provider"] == "openai"
    assert deleted.json()["has_api_key"]
    assert not put("gemini")["has_api_key"]
    assert client.get(url, headers=other).json()["has_api_key"]

    async def verify_legacy_removed():
        async for db in client.app.dependency_overrides[get_db]():
            user = await db.get(User, uuid.UUID(account_data["id"]))
            assert user.ai_api_key_encrypted is None
            remaining = await db.scalar(sa.select(UserAiKey.encrypted_key).where(
                UserAiKey.user_id == user.id, UserAiKey.provider == "openai",
            ))
            assert crypto.decrypt(remaining) == "clave-openai-ficticia"

    asyncio.run(verify_legacy_removed())


def test_profile_rejects_private_custom_url_before_saving_credentials(client, monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    headers, _, _ = account(client, "url-invalida")
    url = "/api/v1/assistant/profile"
    response = client.put(url, headers=headers, json={
        "provider": "custom", "base_url": "https://192.168.0.1/v1",
        "model": "simulado", "api_key": "clave-ficticia-no-guardada",
    })
    assert response.status_code == 400
    assert "pública y usar HTTPS" in response.json()["detail"]
    assert "clave-ficticia-no-guardada" not in response.text
    status = client.get(url, headers=headers).json()
    assert status["provider"] == "local"
    assert status["providers_with_key"] == []


def test_migration_copies_ciphertext_to_selected_provider_and_keeps_original():
    file = Path(__file__).resolve().parents[1] / "alembic/versions/0029_user_ai_keys.py"
    spec = spec_from_file_location("user_ai_keys_migration", file)
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "0028_grade_classification"
    engine = sa.create_engine("sqlite://")
    encrypted = crypto.encrypt("clave-de-migracion-simulada")
    with engine.begin() as db:
        db.exec_driver_sql("CREATE TABLE users (id UUID PRIMARY KEY, ai_provider VARCHAR(16) NOT NULL, ai_api_key_encrypted VARCHAR(512))")
        db.execute(sa.text("INSERT INTO users VALUES ('a', 'openrouter', :key), ('b', 'gemini', NULL)"), {"key": encrypted})
        with Operations.context(MigrationContext.configure(db)):
            migration.upgrade()
        assert db.exec_driver_sql("SELECT user_id, provider, encrypted_key FROM user_ai_keys").all() == [
            ("a", "openrouter", encrypted),
        ]
        assert db.exec_driver_sql("SELECT ai_api_key_encrypted FROM users ORDER BY id").scalars().all() == [
            encrypted, None,
        ]
