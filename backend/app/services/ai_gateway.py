"""Salida común a proveedores de IA. Las funciones preparan sus mensajes y acciones."""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.core.config import settings
from app.core.logging import get_logger
from app.models.user import User
from app.models.user_ai_key import UserAiKey
from app.services.ai_errors import REMOTE_PROVIDERS, AiKeyRequired, AiRequestRejected, log_provider_error

logger = get_logger(__name__)
Source = Literal["studio", "repaso", "notas", "libros", "horario", "transcripcion", "asistente"]
Operation = Literal["texto", "imagen", "audio"]
FUNDING = "clave_del_alumno"
_IPV6_TRANSLATION_NETWORKS = tuple(
    ipaddress.IPv6Network(network) for network in ("64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/32")
)


@dataclass(frozen=True)
class AiProfile:
    provider: str
    base_url: str = field(repr=False)
    model: str
    vision_model: str
    api_key: str = field(repr=False)
    temperature: float
    timeout_seconds: int
    tools_enabled: bool
    max_tool_iterations: int

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model and (self.api_key or self.provider == "local"))


def active_provider(user: User) -> str:
    return (user.ai_provider or settings.ai_default_provider).lower()


def resolve_profile(user: User, encrypted_key: str | None = None) -> AiProfile:
    provider = active_provider(user)
    if provider == "local":
        base_url, model, vision = settings.ai_base_url, settings.ai_model, settings.ai_vision_model
        api_key = settings.ai_api_key
    else:
        if provider == "custom":
            base_url, model, vision = user.ai_base_url or "", "", ""
        elif provider in REMOTE_PROVIDERS:
            base_url = getattr(settings, f"ai_{provider}_base_url")
            model = getattr(settings, f"ai_{provider}_model")
            vision = settings.ai_gemini_vision_model if provider == "gemini" else model
        else:
            raise AiRequestRejected(status_code=400, detail="Selecciona un proveedor de IA en Ajustes.")
        if user.ai_model:
            model = vision = user.ai_model.strip() or model
        api_key = crypto.decrypt(encrypted_key) or ""
    return AiProfile(
        provider, base_url.strip().rstrip("/"), model, vision, api_key,
        settings.ai_temperature, settings.ai_timeout_seconds,
        settings.ai_tools_enabled, settings.ai_max_tool_iterations,
    )


async def load_profile(db: AsyncSession, user: User) -> AiProfile:
    provider = active_provider(user)
    encrypted_key = None
    if provider in REMOTE_PROVIDERS:
        encrypted_key = await db.scalar(select(UserAiKey.encrypted_key).where(
            UserAiKey.user_id == user.id, UserAiKey.provider == provider,
        ))
    return resolve_profile(user, encrypted_key)


def require_personal_key(profile: AiProfile) -> None:
    if profile.provider in REMOTE_PROVIDERS and not profile.api_key:
        raise AiKeyRequired()


@dataclass(frozen=True)
class ChatRequest:
    messages: list[dict[str, Any]] = field(repr=False)
    tools: list[dict[str, Any]] | None = field(default=None, repr=False)
    max_tokens: int | None = None
    temperature: float | None = None
    use_vision_model: bool = False
    minimum_timeout: int | None = None
    maximum_timeout: int | None = None


@dataclass(frozen=True)
class GeminiRequest:
    system: str = field(repr=False)
    contents: list[dict[str, Any]] = field(repr=False)
    tools: list[dict[str, Any]] | None = field(default=None, repr=False)


@dataclass(frozen=True)
class AudioRequest:
    filename: str = field(repr=False)
    content: bytes = field(repr=False)
    content_type: str


async def check_quota(user: User, source: Source, funding: str) -> None:
    """Punto de control para una futura política de cuota."""


async def record_usage(user: User, source: Source, funding: str) -> None:
    """Punto de contabilización sin datos de la petición ni credenciales."""


def gemini_native_url(profile: AiProfile, model: str) -> str:
    return f"{profile.base_url.rstrip('/').removesuffix('/openai')}/models/{model}:generateContent"


def _custom_hosted() -> bool:
    return settings.environment in {"production", "staging"}


def public_base_url(value: str) -> str:
    """Omite credenciales que puedan existir en URLs históricas."""
    try:
        url = httpx.URL(value)
        return str(url.copy_with(username=None, password=None, query=None, fragment=None))
    except (httpx.InvalidURL, ValueError):
        return ""


def _custom_url_error() -> AiRequestRejected:
    return AiRequestRejected(
        status_code=400, detail="La URL de la IA personalizada debe ser pública y usar HTTPS.",
    )


def _public_ip(host: str) -> bool:
    address = ipaddress.ip_address(host)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if isinstance(address, ipaddress.IPv6Address):
        if address.is_site_local or any(address in network for network in _IPV6_TRANSLATION_NETWORKS):
            return False
    return address.is_global and not address.is_multicast and not address.is_reserved


async def validate_custom_url(base_url: str) -> tuple[httpx.URL, str | None]:
    try:
        url = httpx.URL(base_url)
        if (
            not url.host or url.userinfo or url.query or url.fragment
            or url.scheme not in {"http", "https"}
            or (_custom_hosted() and url.scheme != "https")
        ):
            raise _custom_url_error()
        if not _custom_hosted():
            return url, None
        host = url.raw_host.decode("ascii")
        if host.rstrip(".").lower().split(".")[-1] in {"localhost", "local", "internal"}:
            raise _custom_url_error()
        try:
            addresses = [str(ipaddress.ip_address(host))]
        except ValueError:
            entries = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, url.port or 443, type=socket.SOCK_STREAM),
                timeout=5,
            )
            addresses = list(dict.fromkeys(entry[4][0] for entry in entries))
        if not addresses or not all(_public_ip(address) for address in addresses):
            raise _custom_url_error()
        return url, min(addresses, key=lambda address: ipaddress.ip_address(address).version)
    except (httpx.InvalidURL, OSError, ValueError, TimeoutError):
        raise _custom_url_error() from None


async def _post(
    user: User, source: Source, profile: AiProfile, endpoint: str, timeout: int,
    headers: dict[str, str], **body: Any,
) -> httpx.Response:
    extensions = {}
    pinned = profile.provider == "custom" and _custom_hosted()
    if profile.provider == "custom":
        url, address = await validate_custom_url(endpoint)
        if address:
            # Conecta a la IP comprobada y conserva el nombre para TLS y Host.
            # Así la conexión nunca vuelve a resolver el DNS del usuario.
            headers = {**headers, "Host": url.netloc.decode("ascii")}
            extensions["sni_hostname"] = url.raw_host.decode("ascii")
            endpoint = str(url.copy_with(host=address))
    await check_quota(user, source, FUNDING)
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=not pinned, follow_redirects=False) as client:
            response = await client.post(endpoint, headers=headers, extensions=extensions, **body)
        if not response.is_success:
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as error:
                log_provider_error(logger, profile.provider, error)
        return response
    except httpx.RequestError as error:
        log_provider_error(logger, profile.provider, error)
        raise
    finally:
        await record_usage(user, source, FUNDING)


def _audio_unsupported() -> AiRequestRejected:
    return AiRequestRejected(
        status_code=400,
        detail="Este proveedor no admite la transcripción de audio en Atlantium. "
        "Selecciona OpenAI, OpenRouter o un servidor compatible en Ajustes.",
    )


async def request_ai(
    db: AsyncSession, user: User, source: Source, operation: Operation,
    request: ChatRequest | GeminiRequest | AudioRequest, *, profile: AiProfile | None = None,
) -> dict[str, Any]:
    """Envía un turno o una transcripción y aplica cuota a cada intento real."""
    profile = profile if profile is not None else await load_profile(db, user)
    require_personal_key(profile)
    if isinstance(request, AudioRequest):
        if operation != "audio":
            raise ValueError("Operación de IA incompatible con la petición")
        if profile.provider in {"gemini", "claude"}:
            raise _audio_unsupported()
        if not profile.base_url:
            raise _audio_unsupported()
        headers = {"Authorization": f"Bearer {profile.api_key}"} if profile.api_key else {}
        model = settings.ai_transcribe_model
        if profile.provider == "openrouter" and "/" not in model:
            model = f"openai/{model}"
        response = await _post(
            user, source, profile, profile.base_url + "/audio/transcriptions", 300, headers,
            files={"file": (request.filename, request.content, request.content_type)},
            data={"model": model, "language": "es"},
        )
        if response.status_code in {404, 405, 501}:
            raise _audio_unsupported()
        response.raise_for_status()
        return response.json()

    if operation == "audio":
        raise ValueError("Operación de IA incompatible con la petición")
    if not profile.configured:
        raise RuntimeError("IA no configurada")
    timeout = profile.timeout_seconds
    headers = {"Content-Type": "application/json"}
    if isinstance(request, GeminiRequest):
        if profile.provider != "gemini":
            raise ValueError("El protocolo nativo solo se admite con Gemini")
        model = profile.vision_model if operation == "imagen" else profile.model
        endpoint = gemini_native_url(profile, model)
        headers["x-goog-api-key"] = profile.api_key
        payload = {
            "systemInstruction": {"parts": [{"text": request.system}]},
            "contents": request.contents,
            "generationConfig": {"temperature": profile.temperature},
        }
        tool_options = {"toolConfig": {"functionCallingConfig": {"mode": "AUTO"}}}
        result_list, result_key = "candidates", "content"
    else:
        if profile.api_key:
            headers["Authorization"] = f"Bearer {profile.api_key}"
        endpoint = profile.base_url + "/chat/completions"
        model = profile.vision_model if request.use_vision_model else profile.model
        if request.minimum_timeout is not None:
            timeout = max(timeout, request.minimum_timeout)
        if request.maximum_timeout is not None:
            timeout = min(timeout, request.maximum_timeout)
        payload = {
            "model": model,
            "messages": request.messages,
            "temperature": profile.temperature if request.temperature is None else request.temperature,
            "stream": False,
        }
        if request.max_tokens is not None:
            payload["max_tokens"] = request.max_tokens
        tool_options = {"tool_choice": "auto"}
        result_list, result_key = "choices", "message"
    response = await _post(
        user, source, profile, endpoint, timeout, headers,
        json={**payload, "tools": request.tools, **tool_options} if request.tools else payload,
    )
    if response.status_code == 400 and request.tools:
        response = await _post(user, source, profile, endpoint, timeout, headers, json=payload)
    response.raise_for_status()
    results = response.json().get(result_list) or []
    return (results[0].get(result_key) or {}) if results else {}


async def tool_turns(
    db: AsyncSession, user: User, source: Source, operation: Operation,
    request: ChatRequest | GeminiRequest, *, profile: AiProfile,
    before_turn: Callable[[], None] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Limita las rondas. El flujo añade al historial los resultados de sus acciones."""
    for _ in range(max(1, profile.max_tool_iterations)):
        if before_turn is not None:
            before_turn()
        yield await request_ai(db, user, source, operation, request, profile=profile)
