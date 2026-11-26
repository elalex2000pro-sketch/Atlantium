"""Mensajes seguros del proveedor: nunca incluyen URL, clave ni respuesta remota."""
import logging
import re
from enum import Enum

import httpx
from fastapi import HTTPException


REMOTE_PROVIDERS = frozenset({"gemini", "openai", "claude", "openrouter", "custom"})


class AiErrorCode(str, Enum):
    CREDENTIALS_REQUIRED = "ai_credentials_required"
    INVALID_CREDENTIALS = "ai_invalid_credentials"
    PERMISSION_DENIED = "ai_permission_denied"
    MODEL_UNAVAILABLE = "ai_model_unavailable"
    INCOMPATIBLE_REQUEST = "ai_incompatible_request"
    PROVIDER_QUOTA = "ai_provider_quota"
    LOCAL_QUOTA = "ai_local_quota"
    SATURATED = "ai_provider_saturated"
    TIMEOUT = "ai_timeout"
    CONNECTION = "ai_connection_error"
    EMPTY_RESPONSE = "ai_empty_response"
    BLOCKED_RESPONSE = "ai_blocked_response"
    TOOL_LIMIT = "ai_tool_limit"
    PROVIDER_ERROR = "ai_provider_error"


_GEMINI_MESSAGES = {
    AiErrorCode.INVALID_CREDENTIALS: "La clave de Gemini no es válida. Revísala en Ajustes.",
    AiErrorCode.PERMISSION_DENIED: "Tu clave o proyecto no tiene permiso para esta solicitud de Gemini. Revísalo en Ajustes.",
    AiErrorCode.MODEL_UNAVAILABLE: "Este modelo ya no está disponible. Elige otro en Ajustes",
    AiErrorCode.INCOMPATIBLE_REQUEST: "Gemini no admite esta solicitud con el modelo, contexto o herramientas seleccionados.",
    AiErrorCode.PROVIDER_QUOTA: "Gemini ha alcanzado un límite de uso de tu proyecto. Revisa la cuota en Google AI Studio o inténtalo más tarde.",
    AiErrorCode.LOCAL_QUOTA: "Has alcanzado un límite de uso de IA de Atlantium. Inténtalo más tarde.",
    AiErrorCode.SATURATED: "Gemini está temporalmente saturado. Inténtalo más tarde.",
    AiErrorCode.TIMEOUT: "Gemini no respondió a tiempo. Puedes intentarlo más tarde.",
    AiErrorCode.CONNECTION: "No se pudo establecer conexión con Gemini. Comprueba tu conexión.",
    AiErrorCode.EMPTY_RESPONSE: "Gemini no devolvió una respuesta utilizable.",
    AiErrorCode.BLOCKED_RESPONSE: "Gemini bloqueó la solicitud o la respuesta. Revisa el contenido e inténtalo con otra formulación.",
    AiErrorCode.TOOL_LIMIT: "Se alcanzó el límite de pasos del asistente antes de terminar la solicitud.",
    AiErrorCode.PROVIDER_ERROR: "Gemini no pudo completar la solicitud.",
}


class AiRequestRejected(HTTPException):
    """Rechazo previsto que debe llegar al usuario, incluso si hay fallback."""


class AiKeyRequired(AiRequestRejected):
    def __init__(self) -> None:
        super().__init__(
            status_code=400, detail="Falta tu clave de IA en Ajustes",
            headers={"X-AI-Error-Code": AiErrorCode.CREDENTIALS_REQUIRED.value},
        )


def log_provider_error(logger: logging.Logger, provider: str | None, error: Exception) -> None:
    safe_provider = provider if provider in REMOTE_PROVIDERS or provider == "local" else "desconocido"
    status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
    if safe_provider == "gemini":
        logger.warning(
            "Error de IA tipo=%s proveedor=%s estado=%s codigo=%s",
            type(error).__name__, safe_provider, status, gemini_error_code(error).value,
        )
    else:
        logger.warning("Error de IA tipo=%s proveedor=%s estado=%s", type(error).__name__, safe_provider, status)


class AiProviderError(RuntimeError):
    pass


class GeminiResponseError(AiProviderError):
    def __init__(self, code: AiErrorCode) -> None:
        self.code = code
        super().__init__(_GEMINI_MESSAGES[code])


def _gemini_error_detail(response: httpx.Response) -> dict:
    try:
        body = response.json()
    except ValueError:
        return {}
    detail = body.get("error") if isinstance(body, dict) else None
    return detail if isinstance(detail, dict) else {}


def _gemini_model_unavailable(detail: dict) -> bool:
    message = detail.get("message", "")
    return detail.get("status") == "NOT_FOUND" or (
        isinstance(message, str) and bool(re.search(
            r"\bmodels?\b[^\n]*(?:not found|no longer available|not available|does not exist)", message, re.I,
        ))
    )


def gemini_error_code(error: Exception) -> AiErrorCode:
    if isinstance(error, GeminiResponseError):
        return error.code
    if isinstance(error, AiRequestRejected) and error.status_code == 429:
        return AiErrorCode.LOCAL_QUOTA
    if isinstance(error, httpx.TimeoutException):
        return AiErrorCode.TIMEOUT
    if isinstance(error, httpx.RequestError):
        return AiErrorCode.CONNECTION
    if not isinstance(error, httpx.HTTPStatusError):
        return AiErrorCode.PROVIDER_ERROR

    status = error.response.status_code
    if status in (400, 401, 403, 404):
        detail = _gemini_error_detail(error.response)
        entries = detail.get("details")
        invalid_key = isinstance(entries, list) and any(
            isinstance(entry, dict) and entry.get("reason") in (
                "API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_NOT_FOUND",
            ) for entry in entries
        )
        if status == 401 or invalid_key or detail.get("status") == "UNAUTHENTICATED":
            return AiErrorCode.INVALID_CREDENTIALS
        if status == 404 or _gemini_model_unavailable(detail):
            return AiErrorCode.MODEL_UNAVAILABLE
        if status == 403:
            return AiErrorCode.PERMISSION_DENIED
        return AiErrorCode.INCOMPATIBLE_REQUEST
    return {
        413: AiErrorCode.INCOMPATIBLE_REQUEST,
        422: AiErrorCode.INCOMPATIBLE_REQUEST,
        429: AiErrorCode.PROVIDER_QUOTA,
        503: AiErrorCode.SATURATED,
        408: AiErrorCode.TIMEOUT,
        504: AiErrorCode.TIMEOUT,
    }.get(status, AiErrorCode.PROVIDER_ERROR)


def provider_error_message(error: Exception, provider: str | None = None) -> str:
    if provider == "gemini":
        return _GEMINI_MESSAGES[gemini_error_code(error)]
    if isinstance(error, httpx.HTTPStatusError):
        code = error.response.status_code
        if code in (401, 403):
            return "No se pudo usar tu clave de IA. Revisa la clave y sus permisos en Ajustes."
        if code in (400, 404):
            return "Este modelo no está disponible con tu clave o no admite esta solicitud. Puedes volver al modelo por defecto."
        if code == 429:
            return "Has alcanzado el límite de uso de este modelo. Inténtalo más tarde o vuelve al modelo por defecto."
    if isinstance(error, httpx.RequestError):
        return "No se pudo conectar con la IA. Comprueba tu conexión e inténtalo de nuevo."
    return "La IA no pudo completar la solicitud. Inténtalo de nuevo o vuelve al modelo por defecto."
