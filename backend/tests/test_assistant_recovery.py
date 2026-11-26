"""Pruebas de recuperación autenticada de solo lectura del asistente (ATL-108 bloque 2)."""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from chat_test_server import create_test_app
from fastapi.testclient import TestClient

from app.core.rate_limit import limiter
from app.db.base import utcnow
from app.services import ai_gateway, assistant_operations

CHAT = "/api/v1/assistant/chat"
CONFIRM = "/api/v1/assistant/confirm"


@pytest.fixture
def client(tmp_path: Path):
    limiter.reset()
    with TestClient(create_test_app(tmp_path)) as test_client:
        yield test_client


def _account(client: TestClient, name: str) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": f"{name}-{uuid.uuid4()}@example.com", "password": "RecoveryPassword123", "full_name": name},
    )
    assert response.status_code == 201, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _mock_model(monkeypatch: pytest.MonkeyPatch, handler):
    profile = ai_gateway.AiProfile("local", "http://model.invalid", "mock", "mock", "", 0, 5, True, 3)

    async def load(*_args):
        return profile

    monkeypatch.setattr(ai_gateway, "load_profile", load)
    monkeypatch.setattr(ai_gateway, "request_ai", handler)


def test_operation_recovery_after_commit_is_read_only_and_isolated(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    alice = _account(client, "alice")
    bob = _account(client, "bob")
    calls = 0

    async def model(_db, _user, _source, _op, request, **_):
        nonlocal calls
        calls += 1
        if request.messages[-1]["role"] == "tool":
            return {"content": "Tarea creada correctamente."}
        return {"tool_calls": [{"id": "c1", "function": {"name": "create_task", "arguments": json.dumps({"title": "Repasar redes"})}}]}

    _mock_model(monkeypatch, model)
    request_id = str(uuid.uuid4())
    sent = client.post(CHAT, json={"request_id": request_id, "message": "Crea una tarea"}, headers=alice)
    assert sent.status_code == 200
    assert calls == 2

    # Al consultar tras recarga sin prompt ni reejecución, devuelve la misma respuesta sin llamar al modelo.
    recovered = client.get(f"/api/v1/assistant/operations/{request_id}", headers=alice)
    assert recovered.status_code == 200
    assert recovered.json() == sent.json()
    assert calls == 2
    assert len(client.get("/api/v1/tasks", headers=alice).json()) == 1

    # Aislamiento por cuenta: otra cuenta recibe 404 y un UUID inexistente también 404.
    assert client.get(f"/api/v1/assistant/operations/{request_id}", headers=bob).status_code == 404
    assert client.get(f"/api/v1/assistant/operations/{uuid.uuid4()}", headers=alice).status_code == 404

    # Caducidad a los 30 días: 410 sin reejecutar.
    with monkeypatch.context() as m:
        m.setattr(assistant_operations, "utcnow", lambda: utcnow() + timedelta(days=31))
        assert client.get(f"/api/v1/assistant/operations/{request_id}", headers=alice).status_code == 410
    assert calls == 2


def test_proposal_recovery_pending_decided_and_isolated(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    alice = _account(client, "alice")
    bob = _account(client, "bob")

    async def model(_db, _user, _source, _op, request, **_):
        if request.messages[-1]["role"] == "tool":
            return {"content": "Hecho."}
        if "borrar" in request.messages[-1]["content"].lower():
            return {"tool_calls": [{"id": "c2", "function": {"name": "delete_task", "arguments": json.dumps({"task_title": "Borrable"})}}]}
        return {"tool_calls": [{"id": "c1", "function": {"name": "create_task", "arguments": json.dumps({"title": "Borrable"})}}]}

    _mock_model(monkeypatch, model)
    assert client.post(CHAT, json={"request_id": str(uuid.uuid4()), "message": "Crea Borrable"}, headers=alice).status_code == 200
    draft = client.post(CHAT, json={"request_id": str(uuid.uuid4()), "message": "Borrar Borrable"}, headers=alice)
    assert draft.status_code == 200
    proposal_id = draft.json()["pending_action"]["proposal_id"]

    # Antes de decidir, GET /proposals/{id} recupera la acción pendiente sin ejecutarla.
    pending_status = client.get(f"/api/v1/assistant/proposals/{proposal_id}", headers=alice)
    assert pending_status.status_code == 200
    assert pending_status.json()["status"] == "pending"
    assert pending_status.json()["pending_action"]["proposal_id"] == proposal_id
    assert len(client.get("/api/v1/tasks", headers=alice).json()) == 1

    # Otra cuenta no puede consultar ni confirmar la propuesta.
    assert client.get(f"/api/v1/assistant/proposals/{proposal_id}", headers=bob).status_code == 404

    # Confirmar borra exactamente una vez; repetir confirmación o consultar por GET devuelve el mismo resultado.
    confirmed = client.post(CONFIRM, json={"proposal_id": proposal_id, "approve": True}, headers=alice)
    assert confirmed.status_code == 200
    assert len(client.get("/api/v1/tasks", headers=alice).json()) == 0

    repeated = client.post(CONFIRM, json={"proposal_id": proposal_id, "approve": True}, headers=alice)
    assert repeated.status_code == 200
    assert repeated.json() == confirmed.json()

    recovered = client.get(f"/api/v1/assistant/proposals/{proposal_id}", headers=alice)
    assert recovered.status_code == 200
    assert recovered.json()["status"] == "decided"
    assert recovered.json()["decision"] is True
    assert recovered.json()["response"] == confirmed.json()

    # Si se borra el historial, ya no está disponible (410).
    assert client.delete("/api/v1/assistant/messages", headers=alice).status_code == 204
    assert client.get(f"/api/v1/assistant/proposals/{proposal_id}", headers=alice).status_code == 410
