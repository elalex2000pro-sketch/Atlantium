"""Registro durable del asistente, independiente del historial visible."""
import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AssistantOperation(Base):
    __tablename__ = "assistant_operations"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True,
    )
    request_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    state: Mapped[str] = mapped_column(String(16))
    effects: Mapped[list[str]] = mapped_column(JSON, default=list)
    reply_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("assistant_messages.id", ondelete="SET NULL"), index=True,
    )
    error_code: Mapped[str | None] = mapped_column(String(40))
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, unique=True)
    tool: Mapped[str | None] = mapped_column(String(40))
    target_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decision: Mapped[bool | None] = mapped_column(Boolean)
    confirmation_reply_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("assistant_messages.id", ondelete="SET NULL"), index=True,
    )
