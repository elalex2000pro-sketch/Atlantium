"""Llamadas genericas a la IA del usuario (JSON y transcripcion de audio)."""
from __future__ import annotations

import base64
import json
import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.services import ai_gateway

class AiNotConfigured(RuntimeError):
    """El usuario todavia no ha configurado una IA utilizable."""


async def generate_json(
    db: AsyncSession,
    user: User,
    system: str,
    prompt: str,
    *,
    source: ai_gateway.Source,
    max_tokens: int = 1200,
    temperature: float = 0.4,
) -> dict[str, Any]:
    """Pide a la IA del usuario un objeto JSON valido."""
    profile = await ai_gateway.load_profile(db, user)
    ai_gateway.require_personal_key(profile)
    if not profile.configured or not profile.api_key:
        raise AiNotConfigured(
            "Configura tu IA en Ajustes (Gemini, ChatGPT, Claude u OpenRouter) para usar esta funcion."
        )

    msg = await ai_gateway.request_ai(
        db, user, source, "texto",
        ai_gateway.ChatRequest([
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ], temperature=temperature, max_tokens=max_tokens, minimum_timeout=90),
        profile=profile,
    )
    content = msg.get("content") or ""
    return _extract_json(content)


async def generate_json_with_image(
    db: AsyncSession,
    user: User,
    system: str,
    prompt: str,
    image_bytes: bytes,
    mime: str,
    *,
    max_tokens: int = 1500,
) -> dict[str, Any]:
    """Pide a un modelo con vision que devuelva JSON a partir de una imagen."""
    profile = await ai_gateway.load_profile(db, user)
    ai_gateway.require_personal_key(profile)
    if not profile.configured or not profile.api_key:
        raise AiNotConfigured(
            "Para leer una foto necesitas una IA con vision configurada en Ajustes (OpenAI o Gemini)."
        )
    encoded = base64.b64encode(image_bytes).decode("ascii")
    messages = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{encoded}"},
                },
            ],
        },
    ]
    msg = await ai_gateway.request_ai(
        db, user, "horario", "imagen",
        ai_gateway.ChatRequest(messages, temperature=0.2, max_tokens=max_tokens, minimum_timeout=120),
        profile=profile,
    )
    content = msg.get("content") or ""
    return _extract_json(content)


def _extract_json(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        data = json.loads(text[start : end + 1])
        if isinstance(data, dict):
            return data
    raise ValueError("La IA no devolvio un JSON valido")


async def transcribe_audio(
    db: AsyncSession, user: User, filename: str, content: bytes, content_type: str
) -> str:
    """Transcribe audio con un endpoint compatible con OpenAI Whisper."""
    payload = await ai_gateway.request_ai(
        db, user, "transcripcion", "audio",
        ai_gateway.AudioRequest(filename, content, content_type or "audio/mpeg"),
    )
    text = (payload.get("text") or "").strip()
    if not text:
        raise RuntimeError("La transcripcion llego vacia")
    return text
