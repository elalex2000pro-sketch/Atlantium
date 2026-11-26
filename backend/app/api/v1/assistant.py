"""Endpoints del chat de IA Studio (tutor y organizacion del estudio).

El asistente puede ademas OPERAR la app mediante herramientas (crear/editar
elementos). Las operaciones destructivas se devuelven como accion pendiente y
solo se ejecutan cuando el usuario confirma (endpoint /confirm).
"""
from __future__ import annotations

import base64
import binascii
import os
import uuid
from datetime import timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.orm import undefer
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, DbSession
from app.core import crypto
from app.core.config import settings
from app.core.logging import get_logger
from app.db.base import utcnow
from app.models.assistant_message import AssistantMessage
from app.models.document import Document
from app.models.user import User
from app.models.user_ai_key import UserAiKey
from app.schemas.assistant import (
    AiProvider,
    AiProfileUpdate,
    AssistantImportRequest,
    AssistantMessageRead,
    AssistantStatus,
    ChatAttachment,
    ChatRequest,
    ChatResponse,
    ConfirmRequest,
    MessageAttachment,
    PanelChatRequest,
    PanelPreview,
    PanelPreviewRequest,
    PendingAction,
)
from app.services import ai_gateway, ai_panel_context, ai_service, ai_studio_service, ai_tools, assistant_operations
from app.services.ai_errors import AiRequestRejected, gemini_error_code, log_provider_error, provider_error_message
from app.services.realtime import notify

logger = get_logger(__name__)

router = APIRouter(prefix="/assistant", tags=["assistant"])

_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"}
# Las páginas de PDF se renderizan en el cliente como JPEG; nunca se sube el PDF
# original en el cuerpo JSON.
_ATTACHMENT_TYPES = {"image/png", "image/jpeg", "image/webp"}


@router.get("/status", response_model=AssistantStatus)
async def assistant_status(current_user: CurrentUser, db: DbSession) -> AssistantStatus:
    profile = await ai_gateway.load_profile(db, current_user)
    providers = await db.scalars(select(UserAiKey.provider).where(UserAiKey.user_id == current_user.id))
    return AssistantStatus(
        enabled=settings.ai_enabled,
        configured=profile.configured,
        model=profile.model,
        vision_model=profile.vision_model,
        tools_enabled=profile.tools_enabled,
        base_url=ai_gateway.public_base_url(profile.base_url),
        provider=profile.provider,
        has_api_key=bool(profile.api_key),
        providers_with_key=sorted(providers),
        custom_base_url=ai_gateway.public_base_url(current_user.ai_base_url or ""),
    )


@router.get("/profile", response_model=AssistantStatus)
async def get_profile(current_user: CurrentUser, db: DbSession) -> AssistantStatus:
    """Devuelve el proveedor de IA activo del usuario."""
    return await assistant_status(current_user, db)


async def _lock_profile(current_user: User, db: DbSession) -> None:
    # Serializa actualizaciones y borrados de clave del mismo usuario en PostgreSQL.
    await db.scalar(select(User.id).where(User.id == current_user.id).with_for_update())


async def _store_key(current_user: User, db: DbSession, provider: AiProvider, key: str) -> None:
    saved = await db.get(
        UserAiKey, (current_user.id, provider), options=[undefer(UserAiKey.encrypted_key)],
    )
    if saved is not None and current_user.ai_api_key_encrypted == saved.encrypted_key:
        # Borra también la copia de 0029 cuando pertenece a la clave que se modifica.
        current_user.ai_api_key_encrypted = None
    if key:
        encrypted = crypto.encrypt(key)
        if saved is None:
            db.add(UserAiKey(user_id=current_user.id, provider=provider, encrypted_key=encrypted))
        else:
            saved.encrypted_key = encrypted
    elif saved is not None:
        await db.delete(saved)


@router.put("/profile", response_model=AssistantStatus)
async def update_profile(
    payload: AiProfileUpdate, current_user: CurrentUser, db: DbSession
) -> AssistantStatus:
    """Cambia el proveedor de IA (Local, Gemini, ChatGPT, Claude...) y su clave."""
    key = payload.api_key.get_secret_value().strip() if payload.api_key is not None else None
    if key is not None and len(key) > 500:
        raise HTTPException(status_code=400, detail="La clave de IA supera la longitud permitida.")
    if payload.provider == "custom" and payload.base_url is not None:
        base_url = payload.base_url.strip().rstrip("/")
        if base_url:
            await ai_gateway.validate_custom_url(base_url)
    await _lock_profile(current_user, db)
    await db.refresh(current_user)
    if payload.provider != current_user.ai_provider and payload.model is None:
        current_user.ai_model = None
    current_user.ai_provider = payload.provider
    if key is not None:
        await _store_key(current_user, db, payload.provider, key)
    if payload.model is not None:
        # Cadena vacia = volver al modelo por defecto del proveedor.
        current_user.ai_model = payload.model.strip() or None
    if payload.provider == "custom" and payload.base_url is not None:
        current_user.ai_base_url = base_url or None
    await db.commit()
    logger.info("Proveedor de IA cambiado a %s", payload.provider)
    return await assistant_status(current_user, db)


@router.delete("/profile/keys/{provider}", response_model=AssistantStatus)
async def delete_profile_key(provider: AiProvider, current_user: CurrentUser, db: DbSession) -> AssistantStatus:
    """Borra solo la clave del proveedor indicado en la cuenta autenticada."""
    await _lock_profile(current_user, db)
    await db.refresh(current_user)
    await _store_key(current_user, db, provider, "")
    await db.commit()
    return await assistant_status(current_user, db)


@router.get("/messages", response_model=list[AssistantMessageRead])
async def list_messages(
    current_user: CurrentUser,
    db: DbSession,
    limit: int = Query(50, ge=1, le=200),
) -> list[AssistantMessage]:
    result = await db.execute(
        select(AssistantMessage)
        .where(AssistantMessage.user_id == current_user.id)
        .order_by(AssistantMessage.created_at.desc())
        .limit(limit)
    )
    return list(reversed(list(result.scalars().all())))


async def _prepare_panel(payload: PanelPreviewRequest, current_user: CurrentUser, db: DbSession):
    profile = await ai_gateway.load_profile(db, current_user)
    if payload.provider != profile.provider:
        raise HTTPException(status_code=409, detail="Ha cambiado tu proveedor de IA. Revísalo antes de enviar.")
    ai_gateway.require_personal_key(profile)
    if not profile.configured:
        raise HTTPException(status_code=400, detail="Configura tu motor de IA en Ajustes.")
    images = _prepare_attachments(payload.context.attachments) if "attachments" in payload.context.selected else []
    return profile, await ai_panel_context.build_preview(db, current_user, profile, payload, images)


@router.post("/panel/preview", response_model=PanelPreview)
async def panel_preview(payload: PanelPreviewRequest, current_user: CurrentUser, db: DbSession) -> PanelPreview:
    _, preview = await _prepare_panel(payload, current_user, db)
    return preview


@router.post("/panel/chat", response_model=ChatResponse)
async def panel_chat(payload: PanelChatRequest, current_user: CurrentUser, db: DbSession) -> ChatResponse:
    profile, preview = await _prepare_panel(payload, current_user, db)
    ai_panel_context.require_approval(payload.approval, current_user, profile, preview.sections)
    messages = [entry for section in preview.sections.values() for entry in section]
    has_images = bool(preview.sections.get("attachments"))
    try:
        result = await ai_gateway.request_ai(
            db, current_user, "asistente", "imagen" if has_images else "texto",
            ai_gateway.ChatRequest(messages, use_vision_model=has_images),
            profile=profile,
        )
    except AiRequestRejected:
        raise
    except Exception as exc:  # noqa: BLE001 - solo se devuelve el mensaje seguro
        log_provider_error(logger, profile.provider, exc)
        headers = {"X-AI-Error-Code": gemini_error_code(exc).value} if profile.provider == "gemini" else None
        raise HTTPException(
            status_code=502, detail=provider_error_message(exc, profile.provider), headers=headers,
        ) from None

    reply = result.get("content")
    if not isinstance(reply, str) or not reply.strip():
        raise HTTPException(status_code=502, detail="El proveedor no devolvió una respuesta de texto.")
    return ChatResponse(reply=reply.strip(), source="ai", created_at=utcnow())


@router.post("/chat", response_model=ChatResponse)
async def chat(
    payload: ChatRequest, current_user: CurrentUser, db: DbSession
) -> ChatResponse:
    user_id = current_user.id
    request_id = payload.request_id
    if request_id is None:
        profile = await ai_gateway.load_profile(db, current_user)
        ai_gateway.require_personal_key(profile)
        raise HTTPException(428, "Actualiza Atlantium para enviar solicitudes al asistente de forma segura.")

    operation, created = await assistant_operations.reserve(
        db, user_id, request_id, assistant_operations.fingerprint(payload),
    )
    if not created:
        return await _replay_chat(db, user_id, operation, payload.document_id)

    prepared = _prepare_attachments(payload.attachments)
    if (
        not payload.message.strip()
        and payload.document_id is None
        and not prepared
        and not (payload.page_context or "").strip()
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Escribe un mensaje o adjunta una imagen o un documento",
        )

    profile = await ai_gateway.load_profile(db, current_user)
    ai_gateway.require_personal_key(profile)
    image_data_urls = [item["data_url"] for item in prepared]
    document_text: str | None = None
    document_name: str | None = None
    if payload.document_id is not None:
        image_data_url, document_text, document_name = await _load_attachment(
            db, current_user.id, payload.document_id
        )
        if image_data_url:
            image_data_urls.insert(0, image_data_url)

    # Historial reciente (orden cronologico) para dar contexto al modelo.
    result = await db.execute(
        select(AssistantMessage)
        .where(AssistantMessage.user_id == current_user.id)
        .order_by(AssistantMessage.created_at.desc())
        .limit(settings.ai_history_limit)
    )
    recent = list(reversed(list(result.scalars().all())))
    history = [
        {"role": m.role, "content": m.content}
        for m in recent
        if m.role in ("user", "assistant") and m.content.strip()
    ]

    user_message = AssistantMessage(
        user_id=current_user.id,
        role="user",
        content=payload.message.strip(),
        document_id=payload.document_id,
        attachments=_stored_attachments(prepared),
    )
    db.add(user_message)
    await db.commit()

    async def execute(name: str, args: dict):
        return await assistant_operations.execute(db, current_user, request_id, name, args)

    try:
        result_ai = await ai_service.generate_reply(
            db,
            current_user,
            payload.message,
            history,
            image_data_urls=image_data_urls,
            document_text=document_text,
            document_name=document_name,
            page_context=payload.page_context,
            page_context_label=payload.page_context_label,
            profile=profile,
            execute=execute,
        )
    except AiRequestRejected:
        await db.rollback()
        failed = await assistant_operations.active(db, user_id, request_id)
        failed.state = "interrupted"
        await db.commit()
        raise
    except Exception as exc:  # noqa: BLE001 - el usuario siempre debe recibir respuesta
        log_provider_error(logger, current_user.ai_provider or settings.ai_default_provider, exc)
        result_ai = ai_service.AiResult(
            reply=(
                "Lo siento, ha ocurrido un error interno al procesar tu mensaje. "
                "Vuelve a intentarlo en unos segundos."
            ),
            source="error",
        )

    operation = await assistant_operations.active(db, user_id, request_id)
    proposal = result_ai.pending_action
    pending = None
    if proposal:
        target = await ai_tools.resolve_delete_target(db, current_user, proposal["tool"], proposal["args"])
        if target is None:
            result_ai.reply += "\nNo se encontró un elemento único para confirmar el borrado."
        else:
            operation.proposal_id = uuid.uuid4()
            operation.tool = proposal["tool"]
            operation.target_id = target.id
            pending = await _pending_action(db, user_id, operation)

    assistant_message = AssistantMessage(
        user_id=user_id, role="assistant", content=result_ai.reply, source=result_ai.source,
    )
    db.add(assistant_message)
    await db.flush()
    operation.reply_id = assistant_message.id
    operation.error_code = result_ai.error_code
    operation.state = "completed"
    response = _chat_response(assistant_message, payload.document_id, pending, operation.error_code)
    await db.commit()
    notify(user_id, "assistant", {"action": "message", "id": str(assistant_message.id)})
    return response


def _chat_response(message, document_id=None, pending=None, error_code=None) -> ChatResponse:
    return ChatResponse(
        reply=message.content, source=message.source, created_at=message.created_at,
        document_id=document_id, pending_action=pending, error_code=error_code,
    )


async def _pending_action(db, user_id, operation) -> PendingAction | None:
    if operation.decision is not None or not (operation.proposal_id and operation.tool and operation.target_id):
        return None
    label, _ = await ai_tools.delete_target(db, user_id, operation.tool, operation.target_id)
    if label is None:
        return None
    return PendingAction(proposal_id=operation.proposal_id, tool=operation.tool, args={"elemento": label})


async def _replay_chat(db, user_id, operation, document_id) -> ChatResponse:
    age = assistant_operations.age(operation.started_at)
    if age >= assistant_operations.REPLAY_TTL:
        raise HTTPException(410, "El resultado ha caducado. Este envío no se ejecutará de nuevo.")
    if operation.state == "running" and age < assistant_operations.TURN_TTL:
        raise HTTPException(409, "Este envío sigue en curso. Consulta de nuevo con el mismo identificador.")
    if operation.state != "completed":
        operation.state = "interrupted"
        response = ChatResponse(
            reply=(
                f"El turno se interrumpió. Cambios guardados: {len(operation.effects)}. "
                "Revisa los cambios antes de iniciar otro envío."
            ),
            source="error", error_code="ai_operation_interrupted",
            created_at=operation.started_at, document_id=document_id,
        )
        await db.commit()
        return response

    message = await assistant_operations.owned_message(db, user_id, operation.reply_id)
    if message is None:
        raise HTTPException(410, "La respuesta ya no está en el historial. El envío no se repetirá.")
    pending = None
    if assistant_operations.age(message.created_at) < assistant_operations.PROPOSAL_TTL:
        pending = await _pending_action(db, user_id, operation)
    response = _chat_response(message, document_id, pending, operation.error_code)
    await db.commit()
    return response


@router.post("/confirm", response_model=ChatResponse)
async def confirm_action(
    payload: ConfirmRequest, current_user: CurrentUser, db: DbSession,
) -> ChatResponse:
    user_id = current_user.id
    operation = await assistant_operations.lock(db, user_id, proposal_id=payload.proposal_id)
    age = assistant_operations.age(operation.started_at)
    if operation.decision is not None:
        if operation.decision != payload.approve:
            raise HTTPException(409, "Esta propuesta ya tiene una decisión distinta.")
        message = await assistant_operations.owned_message(db, user_id, operation.confirmation_reply_id)
        if age >= assistant_operations.REPLAY_TTL or message is None:
            raise HTTPException(410, "La confirmación ya se registró y su respuesta no está disponible.")
        response = _chat_response(message)
        await db.commit()
        return response

    proposal = await assistant_operations.owned_message(db, user_id, operation.reply_id)
    if operation.tool is None or proposal is None or assistant_operations.age(proposal.created_at) >= assistant_operations.PROPOSAL_TTL:
        operation.target_id = operation.tool = None
        await db.commit()
        raise HTTPException(410, "La propuesta ha caducado o se eliminó del historial.")
    reply, events = "De acuerdo, no he realizado ningún cambio.", []
    source = "ai"
    if payload.approve:
        if operation.tool not in ai_tools.DESTRUCTIVE:
            raise HTTPException(409, "La herramienta de la propuesta ya no está disponible.")
        label, events = await ai_tools.delete_target(
            db, user_id, operation.tool, operation.target_id, confirm=True,
        )
        if label is None:
            reply, source = "No se pudo completar el borrado: el elemento ya no está disponible.", "error"
        else:
            reply = f"Listo. He eliminado: {label}."

    message = AssistantMessage(user_id=user_id, role="assistant", content=reply, source=source)
    db.add(message)
    await db.flush()
    operation.decision = payload.approve
    operation.confirmation_reply_id = message.id
    operation.target_id = operation.tool = None
    response = _chat_response(message)
    await db.commit()
    notify(user_id, "assistant", {"action": "message", "id": str(message.id)})
    for event in set(events):
        notify(user_id, event, {"action": "changed", "by": "ai"})
    return response


@router.delete("/messages", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def clear_messages(current_user: CurrentUser, db: DbSession) -> None:
    await db.execute(delete(AssistantMessage).where(AssistantMessage.user_id == current_user.id))
    await db.commit()
    notify(current_user.id, "assistant", {"action": "cleared"})


@router.get("/messages/export", response_model=list[AssistantMessageRead])
async def export_messages(current_user: CurrentUser, db: DbSession) -> list[AssistantMessage]:
    """Exporta TODA la conversacion (para transportarla a otro dispositivo)."""
    result = await db.execute(
        select(AssistantMessage)
        .where(AssistantMessage.user_id == current_user.id)
        .order_by(AssistantMessage.created_at.asc())
    )
    return list(result.scalars().all())


@router.post("/messages/import")
async def import_messages(
    payload: AssistantImportRequest, current_user: CurrentUser, db: DbSession
) -> dict[str, int]:
    """Importa una conversacion exportada (se fusiona con la actual)."""
    base_time = utcnow()
    for index, item in enumerate(payload.messages):
        created = item.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        message = AssistantMessage(
            user_id=current_user.id,
            role=item.role,
            content=item.content.strip(),
            source="imported",
        )
        # Sin fecha en el archivo: se conserva el orden original de los mensajes.
        message.created_at = created or base_time + timedelta(milliseconds=index)
        db.add(message)
    await db.commit()
    notify(current_user.id, "assistant", {"action": "imported", "count": len(payload.messages)})
    logger.info("Importados %d mensajes del asistente", len(payload.messages))
    return {"imported": len(payload.messages)}


def _prepare_attachments(attachments: list[ChatAttachment]) -> list[dict[str, Any]]:
    """Valida las imágenes Base64 y las prepara para Gemini y el historial."""
    if not attachments:
        return []
    if len(attachments) > settings.ai_max_attachments:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Puedes adjuntar hasta {settings.ai_max_attachments} imágenes.",
        )

    max_image_bytes = settings.ai_max_image_mb * 1024 * 1024
    max_total_bytes = settings.ai_max_total_attachment_mb * 1024 * 1024
    total_bytes = 0
    prepared: list[dict[str, Any]] = []

    for item in attachments:
        mime_type = (item.mime_type or "").strip().lower()
        if mime_type == "image/jpg":
            mime_type = "image/jpeg"
        if mime_type not in _ATTACHMENT_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Solo se admiten imágenes PNG, JPG o WEBP.",
            )

        try:
            raw = base64.b64decode(item.data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Una de las imágenes adjuntas no es válida.",
            ) from exc

        if not raw:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Una de las imágenes adjuntas está vacía.",
            )
        if len(raw) > max_image_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Cada imagen debe pesar menos de {settings.ai_max_image_mb} MB.",
            )
        total_bytes += len(raw)
        if total_bytes > max_total_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    "Los adjuntos superan el límite total de "
                    f"{settings.ai_max_total_attachment_mb} MB."
                ),
            )
        if not _looks_like_image(raw, mime_type):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El contenido del adjunto no coincide con una imagen válida.",
            )

        prepared.append(
            {
                "name": item.name.strip()[:200] or "imagen",
                "mime_type": mime_type,
                "data_url": (
                    f"data:{mime_type};base64,"
                    f"{base64.b64encode(raw).decode('ascii')}"
                ),
                "preview": _sanitize_preview(item.preview),
                "page": item.page,
                "total_pages": item.total_pages,
            }
        )

    return prepared


def _stored_attachments(prepared: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Solo se guardan las miniaturas: las imágenes completas no van a la BD."""
    return [
        MessageAttachment(
            name=item["name"],
            mime_type=item["mime_type"],
            preview=item["preview"],
            page=item["page"],
            total_pages=item["total_pages"],
        ).model_dump()
        for item in prepared
    ]


def _sanitize_preview(value: str | None) -> str | None:
    """Solo se aceptan miniaturas raster en data URL (nunca SVG ni HTML)."""
    if not value:
        return None
    preview = value.strip()
    allowed = (
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    )
    if not preview.startswith(allowed) or len(preview) > 400_000:
        return None
    return preview


def _looks_like_image(raw: bytes, mime_type: str) -> bool:
    if mime_type == "image/png":
        return raw.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return raw.startswith(b"\xff\xd8\xff")
    if mime_type == "image/webp":
        return len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    return False


async def _load_attachment(
    db: DbSession, user_id: uuid.UUID, document_id: uuid.UUID
) -> tuple[str | None, str | None, str]:
    """Prepara un archivo adjunto para el chat.

    Devuelve (imagen como data URL, texto extraido, nombre). Las imagenes usan el
    modelo de vision; los apuntes y examenes en PDF/Word/Excel/texto se extraen y
    se inyectan en el prompt para poder responder preguntas sobre ellos.
    """
    result = await db.execute(
        select(Document).where(Document.id == document_id, Document.user_id == user_id)
    )
    document = result.scalar_one_or_none()
    if document is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Archivo no encontrado")

    content_type = (document.content_type or "").lower()
    if content_type in _IMAGE_TYPES:
        return _image_data_url(document), None, document.filename

    try:
        text = await run_in_threadpool(ai_studio_service.extract_text, document)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if not text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El documento no contiene texto que se pueda analizar.",
        )
    return None, text, document.filename


def _image_data_url(document: Document) -> str:
    """Carga un documento de imagen y lo devuelve como data URL base64."""
    if document.size_bytes > settings.ai_max_image_mb * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"La imagen supera el limite de {settings.ai_max_image_mb} MB",
        )

    abs_path = os.path.join(settings.files_dir, document.storage_path)
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="La imagen no existe")

    try:
        with open(abs_path, "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("ascii")
    except OSError as exc:  # pragma: no cover - best effort
        log_provider_error(logger, None, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="No se pudo leer la imagen"
        ) from exc

    return f"data:{document.content_type.lower()};base64,{encoded}"
