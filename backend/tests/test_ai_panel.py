"""El panel envía solo el mensaje actual al proveedor configurado."""
import json

import httpx

from app.services import ai_service
from test_ai_gateway import use_transport
from test_chat_flow import account
from test_peer_classwork import client


def test_panel_sends_only_the_current_message(client, monkeypatch):
    headers, _, _ = account(client, "panel")
    base = "/api/v1/assistant"
    assert client.put(base + "/profile", headers=headers, json={
        "provider": "gemini", "api_key": "clave-de-prueba",
    }).status_code == 200
    assert client.post(base + "/messages/import", headers=headers, json={
        "messages": [{"role": "user", "content": "HISTORIAL PRIVADO"}],
    }).status_code == 200
    assert client.post("/api/v1/tasks", headers=headers, json={
        "title": "TAREA PRIVADA",
    }).status_code == 201

    async def forbidden_context(*args):
        raise AssertionError("El panel no debe consultar el contexto académico")

    monkeypatch.setattr(ai_service, "build_context", forbidden_context)
    requests = []

    def provider(request):
        assert request.headers["Authorization"] == "Bearer clave-de-prueba"
        assert request.url.path.endswith("/chat/completions")
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{
            "message": {"content": "Respuesta simulada"},
        }]})

    use_transport(monkeypatch, provider)
    route = base + "/panel/chat"
    for message in ("Primer mensaje", "Siguiente mensaje"):
        response = client.post(route, headers=headers, json={"provider": "gemini", "message": message})
        assert response.status_code == 200, response.text
        assert response.json()["reply"] == "Respuesta simulada"
        assert requests[-1]["messages"] == [{"role": "user", "content": message}]
        assert "tools" not in requests[-1]

    for field, value in (
        ("history", ["HISTORIAL PRIVADO"]),
        ("document_id", "00000000-0000-0000-0000-000000000001"),
        ("attachments", [{"data": "ADJUNTO PRIVADO"}]),
        ("page_context", "PDF PRIVADO"),
        ("academic_context", "TAREA PRIVADA"),
    ):
        rejected = client.post(route, headers=headers, json={
            "provider": "gemini", "message": "No se envía", field: value,
        })
        assert rejected.status_code == 422
    assert len(requests) == 2
    history = client.get(base + "/messages", headers=headers).json()
    assert [entry["content"] for entry in history] == ["HISTORIAL PRIVADO"]


def test_panel_blocks_changed_provider_and_missing_key(client, monkeypatch):
    headers, _, _ = account(client, "panel-sin-clave")
    base = "/api/v1/assistant"
    assert client.put(base + "/profile", headers=headers, json={"provider": "claude"}).status_code == 200

    def cannot_send(request):
        raise AssertionError("No debe salir una petición")

    use_transport(monkeypatch, cannot_send)
    route = base + "/panel/chat"
    response = client.post(route, headers=headers, json={"provider": "gemini", "message": "Hola"})
    assert response.status_code == 409
    response = client.post(route, headers=headers, json={"provider": "claude", "message": "Hola"})
    assert response.status_code == 400
    assert response.json() == {"detail": "Falta tu clave de IA en Ajustes"}
