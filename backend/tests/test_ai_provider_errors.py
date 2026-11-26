import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from app.core.config import settings
from app.db.session import get_db
from app.models.book import Book
from test_chat_flow import account
from test_peer_classwork import client

from app.services import ai_gateway, ai_service, ai_studio_service
from app.services.ai_errors import AiProviderError, gemini_error_code, provider_error_message


@pytest.mark.parametrize(("status", "detail", "code"), [
    (400, {"details": [{"reason": "API_KEY_INVALID"}]}, "ai_invalid_credentials"),
    (401, {}, "ai_invalid_credentials"),
    (403, {"status": "PERMISSION_DENIED"}, "ai_permission_denied"),
    (400, {"message": "Model private is no longer available"}, "ai_model_unavailable"),
    (404, {}, "ai_model_unavailable"),
    (400, {}, "ai_incompatible_request"),
    (429, {}, "ai_provider_quota"),
    (503, {}, "ai_provider_saturated"),
    (504, {}, "ai_timeout"),
])
def test_classifies_gemini_failures_without_echoing_remote_data(status, detail, code):
    request = httpx.Request("POST", "https://example.invalid/?key=SECRET")
    response = httpx.Response(status, request=request, json={"error": {"context": "SECRET", **detail}})
    with pytest.raises(httpx.HTTPStatusError) as failure:
        response.raise_for_status()
    assert gemini_error_code(failure.value) == code
    assert "SECRET" not in provider_error_message(failure.value, "gemini")


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [False, True])
async def test_gemini_does_not_restart_after_persistent_tool(monkeypatch, native):
    profile = ai_gateway.AiProfile("gemini", "https://gemini.invalid/openai", "test", "test", "fake", 0, 5, True, 3)
    first = (
        {"candidates": [{"content": {"parts": [{"functionCall": {"name": "create_task", "args": {}}}]}}]}
        if native else {"choices": [{"message": {"tool_calls": [
            {"id": "call", "function": {"name": "create_task", "arguments": "{}"}}
        ]}}]}
    )
    request = httpx.Request("POST", "https://gemini.invalid")
    post = AsyncMock(side_effect=[
        httpx.Response(200, request=request, json=first),
        httpx.Response(503, request=request, headers={"Retry-After": "0"}),
    ])
    execute = AsyncMock(return_value=({"ok": True}, ["tasks"]))
    monkeypatch.setattr(ai_gateway, "_post", post)
    monkeypatch.setattr(ai_service.ai_tools, "execute_tool", execute)
    monkeypatch.setattr(ai_service, "build_context", AsyncMock(return_value={}))
    monkeypatch.setattr(ai_service, "render_context_text", lambda _: "")

    result = await ai_service.generate_reply(
        None, None, "Crea una tarea", [], profile=profile,
        image_data_urls=["data:image/png;base64,AA=="] if native else [],
    )

    assert result.source == "error"
    assert result.error_code == "ai_provider_saturated"
    assert result.events == ["tasks"]
    assert "ya se guardaron" in result.reply
    assert post.await_count == 2
    execute.assert_awaited_once()


@pytest.mark.parametrize("code,expected", [(401, "clave"), (403, "permisos"), (404, "modelo"), (429, "límite"), (503, "solicitud")])
def test_status_messages_do_not_expose_remote_details(code, expected):
    request = httpx.Request("POST", "https://example.com/?key=SECRET")
    error = httpx.HTTPStatusError("SECRET", request=request, response=httpx.Response(code, request=request))
    message = provider_error_message(error)
    assert expected in message
    assert "SECRET" not in message
    assert "example.com" not in message


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [httpx.ConnectError("SECRET"), httpx.ReadTimeout("SECRET")])
async def test_gemini_chat_reports_network_failure_without_heuristic(monkeypatch, error):
    async def context(*args):
        return {}
    async def fail(*args):
        raise error
    monkeypatch.setattr(ai_service, "build_context", context)
    monkeypatch.setattr(ai_service, "render_context_text", lambda ctx: "")
    monkeypatch.setattr(ai_gateway, "load_profile", AsyncMock(return_value=SimpleNamespace(provider="gemini", configured=True, api_key="simulada")))
    monkeypatch.setattr(ai_service, "_run_model", fail)
    result = await ai_service.generate_reply(None, None, "hola", [])
    assert result.source == "error"
    if isinstance(error, httpx.TimeoutException):
        assert result.error_code == "ai_timeout"
        assert "a tiempo" in result.reply
    else:
        assert result.error_code == "ai_connection_error"
        assert "conexión" in result.reply
    assert "SECRET" not in result.reply


@pytest.mark.asyncio
async def test_gemini_document_generation_does_not_save_fake_success(monkeypatch):
    async def fail(*args):
        raise httpx.ConnectError("SECRET")
    monkeypatch.setattr(ai_studio_service, "extract_text", lambda doc: "texto")
    monkeypatch.setattr(ai_studio_service, "call_llm", fail)
    user = SimpleNamespace(ai_provider="gemini")
    with pytest.raises(AiProviderError, match="conexión"):
        await ai_studio_service.generate(None, user, None, "summary")

@pytest.mark.parametrize("provider", ["gemini", "openai", "claude", "openrouter", "custom"])
def test_remote_ai_without_key_is_rejected_in_every_route(client, monkeypatch, provider):
    monkeypatch.setattr(settings, "ai_api_key", "clave-global-simulada")
    monkeypatch.setattr(settings, "ai_enabled", True)
    calls = []

    async def unexpected_request(*args, **kwargs):
        calls.append(True)
        raise AssertionError("La solicitud no debe llegar a ningún motor")

    monkeypatch.setattr(httpx.AsyncClient, "post", unexpected_request)
    headers, student, _ = account(client, "student")
    base = "/api/v1"
    doc = client.post(
        base + "/files", headers=headers,
        files={"file": ("horario.txt", b"Lunes 08:00-10:00 Matematicas Aula 3", "text/plain")},
    )
    photo = client.post(
        base + "/files", headers=headers,
        files={"file": ("horario.png", b"foto simulada", "image/png")},
    )
    notebook = client.post(
        base + "/notebooks", headers=headers,
        json={"title": "Apuntes", "content": "Apuntes de prueba para generar material de repaso."},
    )
    assert doc.status_code == photo.status_code == notebook.status_code == 201

    async def create_book():
        async for db in client.app.dependency_overrides[get_db]():
            book = Book(
                user_id=uuid.UUID(student["id"]), title="Matemáticas", source_filename="libro.pdf",
                format="pdf", status="ready", total_sections=1, text_available=True,
            )
            db.add(book)
            await db.commit()
            return book.id

    book_id = asyncio.run(create_book())
    profile = {"provider": provider}
    if provider == "custom":
        profile.update(base_url="https://motor.example.invalid/v1", model="simulado")
    configured = client.put(base + "/assistant/profile", headers=headers, json=profile)
    assert configured.status_code == 200, configured.text
    assert not configured.json()["configured"]

    doc_id, photo_id, notebook_id = doc.json()["id"], photo.json()["id"], notebook.json()["id"]
    cases = [
        ("/assistant/chat", {"json": {"message": "Hola"}}),
        ("/studio/generate", {"json": {"document_id": doc_id, "kind": "summary"}}),
        (f"/notebooks/{notebook_id}/chat", {"json": {"question": "Explica los apuntes"}}),
        ("/flashcards/generate", {"json": {"notebook_id": notebook_id}}),
        ("/quizzes/generate", {"json": {"notebook_id": notebook_id}}),
        ("/timetable/import", {"json": {"document_id": doc_id}}),
        ("/timetable/import", {"json": {"document_id": photo_id}}),
        ("/transcribe", {"files": {"file": ("clase.mp3", b"audio", "audio/mpeg")}}),
        (f"/books/{book_id}/ask", {"json": {"question": "¿Qué dice el libro?"}}),
        (f"/books/{book_id}/summary", {"json": {"scope": "book"}}),
    ]
    for path, body in cases:
        response = client.post(base + path, headers=headers, **body)
        assert response.status_code == 400, (path, response.text)
        assert response.json() == {"detail": "Falta tu clave de IA en Ajustes"}, path
    assert calls == []
    assert client.get(base + "/assistant/messages", headers=headers).json() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("server_key", ["", "clave-global-simulada"])
async def test_local_studio_still_calls_configured_server(monkeypatch, server_key):
    monkeypatch.setattr(settings, "ai_base_url", "http://ollama.example.invalid/v1")
    monkeypatch.setattr(settings, "ai_model", "modelo-local")
    monkeypatch.setattr(settings, "ai_api_key", server_key)
    user = SimpleNamespace(ai_provider="local", ai_api_key_encrypted=None, ai_model=None, ai_base_url=None)

    async def post(client, url, *, json, headers, extensions):
        assert url == "http://ollama.example.invalid/v1/chat/completions"
        assert json["model"] == "modelo-local"
        assert headers.get("Authorization") == (f"Bearer {server_key}" if server_key else None)
        request = httpx.Request("POST", url)
        return httpx.Response(
            200, request=request, json={"choices": [{"message": {"content": '{"summary":"Listo"}'}}]},
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    assert await ai_studio_service.call_llm(None, user, "Apuntes", "summary") == {"summary": "Listo"}


@pytest.mark.asyncio
async def test_assistant_logs_only_provider_error_metadata(monkeypatch, caplog):
    secret = "clave-personal-simulada"
    url = f"https://motor.example.invalid/v1?key={secret}"
    request = httpx.Request("POST", url, headers={"Authorization": f"Bearer {secret}"})
    response = httpx.Response(503, request=request, text="contenido privado de respuesta")
    error = httpx.HTTPStatusError(f"{request.url} {request.headers} documento privado", request=request, response=response)

    async def context(*args):
        return {}

    async def fail(*args):
        raise error

    monkeypatch.setattr(ai_service, "build_context", context)
    monkeypatch.setattr(ai_service, "render_context_text", lambda ctx: "")
    monkeypatch.setattr(ai_gateway, "load_profile", AsyncMock(return_value=SimpleNamespace(provider="gemini", configured=True, api_key=secret)))
    monkeypatch.setattr(ai_service, "_run_model", fail)

    result = await ai_service.generate_reply(None, None, "mensaje privado", [])
    assert result.source == "error"
    messages = [record.getMessage() for record in caplog.records if record.name == ai_service.__name__]
    assert messages == ["Error de IA tipo=HTTPStatusError proveedor=gemini estado=503 codigo=ai_provider_saturated"]
    assert all(record.exc_info is None for record in caplog.records)
