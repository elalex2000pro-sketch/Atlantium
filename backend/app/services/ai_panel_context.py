"""Construcción y aprobación del contenido del panel de IA."""
import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.models.document import Document
from app.models.user import User
from app.schemas.assistant import PanelContext, PanelPreview, PanelPreviewRequest
from app.services import ai_gateway, ai_service, ai_studio_service

MAX_TEXT = 48_000
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
APPROVAL_SECONDS = 600


def _approval(user: User, profile: ai_gateway.AiProfile, sections: dict, expires: int) -> str:
    payload = json.dumps(
        [expires, str(user.id), profile.provider, profile.base_url, profile.model, profile.vision_model, sections],
        ensure_ascii=True, separators=(",", ":"),
    ).encode()
    return f"{expires}." + hmac.new(settings.secret_key.encode(), payload, hashlib.sha256).hexdigest()


def require_approval(token: str, user: User, profile: ai_gateway.AiProfile, sections: dict) -> None:
    expiry, _, signature = token.partition(".")
    if expiry.isascii() and expiry.isdecimal() and len(signature) == 64:
        expires = int(expiry)
        if time.time() <= expires <= time.time() + APPROVAL_SECONDS and hmac.compare_digest(
            token.encode(), _approval(user, profile, sections, expires).encode(),
        ):
            return
    raise HTTPException(status_code=409, detail="El contexto cambió o la vista previa caducó. Revísala de nuevo.")


def _text(content: str) -> dict:
    return {"role": "user", "content": content}


async def _document(db: AsyncSession, user: User, context: PanelContext) -> str:
    if context.document_id and context.page_text is not None:
        raise HTTPException(status_code=400, detail="Elige un documento o el PDF abierto.")
    if context.document_id:
        document = await db.scalar(select(Document).where(
            Document.id == context.document_id, Document.user_id == user.id,
        ))
        if document is None:
            raise HTTPException(status_code=404, detail="Documento no encontrado.")
        if document.size_bytes > MAX_DOCUMENT_BYTES:
            raise HTTPException(status_code=413, detail="El documento pesa más de 8 MB. Quita ese elemento o elige otro.")
        try:
            text = await run_in_threadpool(ai_studio_service.extract_text, document, truncate=False)
        except ValueError:
            raise HTTPException(status_code=400, detail="No se pudo leer el documento seleccionado.") from None
        label = document.filename
    else:
        text, label = context.page_text or "", context.page_label or "Página del PDF"
    if not text.strip():
        raise HTTPException(status_code=400, detail="El documento o la página seleccionada no contiene texto legible.")
    return f"{label}\n{text}"


async def build_preview(
    db: AsyncSession, user: User, profile: ai_gateway.AiProfile,
    payload: PanelPreviewRequest, images: list[dict[str, Any]],
) -> PanelPreview:
    context = payload.context
    selected = set(context.selected)
    sections: dict[str, list[dict]] = {}
    if "history" in selected:
        sections["history"] = [entry.model_dump() for entry in context.history]
    if selected & {"tasks", "schedule", "grades"}:
        data = await ai_service.build_context(db, user)
        if "tasks" in selected:
            rows = [
                f"- {task['title']} | entrega: {task['due_at'] or 'sin fecha'} | prioridad: {task['priority']}"
                for task in data["tasks"]
            ]
            sections["tasks"] = [_text("Tareas pendientes:\n" + "\n".join(sorted(rows)))] if rows else []
        if "schedule" in selected:
            rows = [
                f"- {row['day_of_week'] + 1} (lunes = 1) · {row['start']:%H:%M}–{row['end']:%H:%M} · {row['course']}"
                + (f" · {row['location']}" if row["location"] else "")
                for row in data["timetable"]
            ]
            availability = [
                f"- {row['day_of_week'] + 1} (lunes = 1) · {row['start']:%H:%M}–{row['end']:%H:%M}"
                + (f" · {row['label']}" if row["label"] else "")
                for row in data["availability"]
            ]
            blocks = [title + "\n" + "\n".join(sorted(lines)) for title, lines in (
                ("Horario de clases:", rows), ("Disponibilidad:", availability),
            ) if lines]
            sections["schedule"] = [_text("\n\n".join(blocks))] if blocks else []
        if "grades" in selected:
            rows = [
                f"- {grade['course'] or 'Sin asignatura'}: {grade['average_percent']} % ({grade['count']})"
                for grade in data["grades"]
            ]
            sections["grades"] = [_text("Notas (media por asignatura):\n" + "\n".join(sorted(rows)))] if rows else []
    if "document" in selected:
        sections["document"] = [_text(await _document(db, user, context))]
    if "attachments" in selected:
        sections["attachments"] = [
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": image["data_url"]}},
            ]}
            for image in images
        ]

    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Escribe un mensaje.")
    sections["message"] = [_text(message)]
    characters = sum(
        len(entry["content"]) for entries in sections.values() for entry in entries
        if isinstance(entry["content"], str)
    )
    if characters > MAX_TEXT:
        raise HTTPException(status_code=413, detail="El texto supera los 48.000 caracteres. Quita elementos y vuelve a revisar.")
    image_bytes = sum(
        (len(raw) * 3 // 4) - (len(raw) - len(raw.rstrip("=")))
        for image in images for raw in [image["data_url"].split(",", 1)[1]]
    )
    return PanelPreview(
        provider=payload.provider, model=profile.vision_model if images else profile.model,
        sections=sections, characters=characters, image_bytes=image_bytes,
        approval=_approval(user, profile, sections, int(time.time()) + APPROVAL_SECONDS),
    )
