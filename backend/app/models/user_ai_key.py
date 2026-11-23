"""Credenciales cifradas de IA, separadas por proveedor."""
import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class UserAiKey(TimestampMixin, Base):
    __tablename__ = "user_ai_keys"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    provider: Mapped[str] = mapped_column(String(16), primary_key=True)
    encrypted_key: Mapped[str] = mapped_column(Text, nullable=False, deferred_raiseload=True)
