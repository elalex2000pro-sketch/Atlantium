"""Mensajes seguros del proveedor: nunca incluyen URL, clave ni respuesta remota."""
import logging

import httpx
from fastapi import HTTPException


REMOTE_PROVIDERS = frozenset({"gemini", "openai", "claude", "openrouter", "custom"})


class AiRequestRejected(HTTPException):
    """Rechazo previsto que debe llegar al usuario, incluso si hay fallback."""


class AiKeyRequired(AiRequestRejected):
    def __init__(self) -> None:
        super().__init__(status_code=400, detail="Falta tu clave de IA en Ajustes")


def log_provider_error(logger: logging.Logger, provider: str | None, error: Exception) -> None:
    safe_provider = provider if provider in REMOTE_PROVIDERS or provider == "local" else "desconocido"
    status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
    logger.warning("Error de IA tipo=%s proveedor=%s estado=%s", type(error).__name__, safe_provider, status)


class AiProviderError(RuntimeError):
    pass


def provider_error_message(error: Exception) -> str:
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
