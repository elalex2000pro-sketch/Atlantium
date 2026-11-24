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
        payload = {"provider": "gemini", "message": message}
        preview = client.post(base + "/panel/preview", headers=headers, json=payload)
        assert preview.status_code == 200
        response = client.post(route, headers=headers, json={**payload, "approval": preview.json()["approval"]})
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
        rejected = client.post(base + "/panel/preview", headers=headers, json={
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
    route = base + "/panel/preview"
    response = client.post(route, headers=headers, json={"provider": "gemini", "message": "Hola"})
    assert response.status_code == 409
    response = client.post(route, headers=headers, json={"provider": "claude", "message": "Hola"})
    assert response.status_code == 400
    assert response.json() == {"detail": "Falta tu clave de IA en Ajustes"}


def test_panel_preview_matches_provider_and_rejects_stale_or_foreign_approval(client, monkeypatch):
    alice, _, _ = account(client, "alice")
    bob, _, _ = account(client, "bob")
    base = "/api/v1/assistant"

    for headers in (alice, bob):
        assert client.put(base + "/profile", headers=headers, json={
            "provider": "gemini", "api_key": "clave-de-prueba",
        }).status_code == 200
    for headers, title in ((alice, "TAREA DE ALICE"), (bob, "TAREA DE BOB")):
        assert client.post("/api/v1/tasks", headers=headers, json={"title": title}).status_code == 201
    document = client.post("/api/v1/files", headers=bob, files={
        "file": ("nota.txt", b"TEXTO PRIVADO DE BOB", "text/plain"),
    })
    assert document.status_code == 201
    document_id = document.json()["id"]
    payload = {
        "provider": "gemini", "message": "Pregunta actual",
        "context": {
            "selected": ["history", "tasks", "document", "attachments"],
            "history": [{"role": "assistant", "content": "Respuesta previa del panel"}],
            "page_text": "HTML <literal> del PDF\nSegunda línea",
            "page_label": "Página uno",
            "attachments": [{
                "name": "imagen.png", "mime_type": "image/png",
                "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF0cAAAAASUVORK5CYII=",
            }],
        },
    }
    requests = []

    def provider(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "Listo"}}]})

    use_transport(monkeypatch, provider)
    preview_endpoint = base + "/panel/preview"
    send_endpoint = base + "/panel/chat"
    preview = client.post(preview_endpoint, headers=alice, json=payload)
    assert preview.status_code == 200, preview.text
    approved = preview.json()
    assert "TAREA DE ALICE" in preview.text
    assert "TAREA DE BOB" not in preview.text
    assert requests == []
    assert client.post(send_endpoint, headers=alice, json={**payload, "approval": approved["approval"]}).status_code == 200
    assert requests[-1]["messages"] == [item for items in approved["sections"].values() for item in items]
    assert requests[-1]["model"] == approved["model"]
    assert "tools" not in requests[-1]

    without_tasks = {**payload, "context": {**payload["context"], "selected": ["history", "document", "attachments"]}}
    without_tasks_preview = client.post(preview_endpoint, headers=alice, json=without_tasks).json()
    assert client.post(send_endpoint, headers=alice, json={
        **without_tasks, "approval": without_tasks_preview["approval"],
    }).status_code == 200
    assert "TAREA DE ALICE" not in json.dumps(requests[-1])
    assert "Respuesta previa del panel" in json.dumps(requests[-1])

    unchecked = {**payload, "context": {**payload["context"], "selected": []}}
    assert client.post(send_endpoint, headers=alice, json={**unchecked, "approval": approved["approval"]}).status_code == 409
    empty_preview = client.post(preview_endpoint, headers=alice, json=unchecked).json()
    assert client.post(send_endpoint, headers=bob, json={**unchecked, "approval": empty_preview["approval"]}).status_code == 409
    assert client.post(send_endpoint, headers=alice, json={**unchecked, "approval": empty_preview["approval"]}).status_code == 200
    assert requests[-1]["messages"] == [{"role": "user", "content": "Pregunta actual"}]
    assert len(requests) == 3

    foreign = {**payload, "context": {"selected": ["document"], "document_id": document_id}}
    assert client.post(preview_endpoint, headers=alice, json=foreign).status_code == 404
    own = client.post(preview_endpoint, headers=bob, json=foreign)
    assert own.status_code == 200
    assert "TEXTO PRIVADO DE BOB" in own.text


def test_cookie_task_card_previews_only_own_task_and_requires_approval(client, monkeypatch):
    alice, _, _ = account(client, "cookie-alice")
    bob, _, _ = account(client, "cookie-bob")
    base = "/api/v1/assistant"
    assert client.put(base + "/profile", headers=alice, json={
        "provider": "gemini", "api_key": "clave-de-prueba",
    }).status_code == 200

    def task_id(headers, title):
        response = client.post("/api/v1/tasks", headers=headers, json={"title": title})
        assert response.status_code == 201
        return response.json()["id"]

    chosen = task_id(alice, "TAREA ELEGIDA")
    task_id(alice, "OTRA TAREA")
    foreign = task_id(bob, "TAREA AJENA")
    requests = []

    def provider(request):
        requests.append(json.loads(request.content)["messages"])
        return httpx.Response(200, json={"choices": [{"message": {"content": "Listo"}}]})

    use_transport(monkeypatch, provider)
    payload = {"provider": "gemini", "message": "Ayúdame a preparar esta tarea.",
               "context": {"selected": ["tasks"], "task_id": chosen}}
    preview = client.post(base + "/panel/preview", headers=alice, json=payload)
    assert preview.status_code == 200, preview.text
    assert "TAREA ELEGIDA" in preview.text
    assert "OTRA TAREA" not in preview.text
    assert client.post(base + "/panel/preview", headers=alice, json={
        **payload, "context": {"selected": ["tasks"], "task_id": foreign},
    }).status_code == 404
    assert requests == []

    unchecked = {**payload, "context": {"selected": [], "task_id": chosen}}
    assert client.post(base + "/panel/chat", headers=alice, json={
        **unchecked, "approval": preview.json()["approval"],
    }).status_code == 409
    fresh = client.post(base + "/panel/preview", headers=alice, json=unchecked)
    assert requests == []
    assert client.post(base + "/panel/chat", headers=alice, json={
        **unchecked, "approval": fresh.json()["approval"],
    }).status_code == 200
    assert requests == [[{"role": "user", "content": payload["message"]}]]


def test_preview_warns_about_size_instead_of_truncating(client):
    headers, _, _ = account(client, "contexto-grande")
    response = client.post("/api/v1/assistant/panel/preview", headers=headers, json={
        "provider": "local", "message": "Hola",
        "context": {"selected": ["history"], "history": [
            {"role": "user", "content": "x" * 48_000},
        ]},
    })
    assert response.status_code == 413
    assert "Quita elementos" in response.json()["detail"]
