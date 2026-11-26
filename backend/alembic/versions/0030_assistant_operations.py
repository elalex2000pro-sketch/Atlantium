"""Protección persistente contra la repetición de acciones del asistente."""
from alembic import op
import sqlalchemy as sa

revision = "0030_assistant_operations"
down_revision = "0029_user_ai_keys"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "assistant_operations",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("request_id", sa.Uuid(), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("effects", sa.JSON(), nullable=False),
        sa.Column("reply_id", sa.Uuid(), sa.ForeignKey("assistant_messages.id", ondelete="SET NULL")),
        sa.Column("error_code", sa.String(40)),
        sa.Column("proposal_id", sa.Uuid(), unique=True),
        sa.Column("tool", sa.String(40)),
        sa.Column("target_id", sa.Uuid()),
        sa.Column("decision", sa.Boolean()),
        sa.Column("confirmation_reply_id", sa.Uuid(), sa.ForeignKey("assistant_messages.id", ondelete="SET NULL")),
    )
    op.create_index("ix_assistant_operations_reply_id", "assistant_operations", ["reply_id"])
    op.create_index("ix_assistant_operations_confirmation_reply_id", "assistant_operations", ["confirmation_reply_id"])


def downgrade():
    op.drop_table("assistant_operations")
