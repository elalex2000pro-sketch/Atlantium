"""Separa las claves de IA por proveedor sin modificar el dato original."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0029_user_ai_keys"
down_revision = "0028_grade_classification"
branch_labels = depends_on = None


def upgrade():
    op.create_table(
        "user_ai_keys",
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(16), nullable=False),
        sa.Column("encrypted_key", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "provider"),
    )
    # Alembic aplica el DDL y la copia en la misma transacción en PostgreSQL.
    op.execute(sa.text("""
        INSERT INTO user_ai_keys (user_id, provider, encrypted_key)
        SELECT id, lower(ai_provider), ai_api_key_encrypted
        FROM users
        WHERE ai_api_key_encrypted IS NOT NULL AND ai_api_key_encrypted <> ''
    """))


def downgrade():
    op.drop_table("user_ai_keys")
