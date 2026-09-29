"""Учебные материалы преподавателя и их назначение занятиям (C-07)."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "materials",
        sa.Column("id", UUID(), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("owner_id", UUID(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("media_type", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("relative_path", sa.String(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("purpose IN ('reference', 'evaluation')"),
        sa.CheckConstraint("size_bytes BETWEEN 1 AND 10485760"),
    )
    op.create_index("ix_materials_owner_id", "materials", ["owner_id"])
    op.create_table(
        "session_materials",
        sa.Column("session_id", UUID(), sa.ForeignKey("sessions.id"), primary_key=True),
        sa.Column("material_id", UUID(), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.ForeignKeyConstraint(["material_id", "version"], ["materials.id", "materials.version"]),
    )
    op.create_table(
        "material_assignment_receipts",
        sa.Column("actor_id", UUID(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("request_id", UUID(), primary_key=True),
        sa.Column("session_id", UUID(), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("body", JSONB(), nullable=False),
        sa.Column("response", JSONB(), nullable=False),
    )
    # Версии материалов неизменяемы: правка — только новой версией (I-CONTENT).
    op.execute(
        """
        CREATE FUNCTION materials_immutable() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'materials rows are immutable';
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        "CREATE TRIGGER materials_no_update BEFORE UPDATE OR DELETE ON materials "
        "FOR EACH ROW EXECUTE FUNCTION materials_immutable()"
    )


def downgrade() -> None:
    used = op.get_bind().scalar(sa.text("SELECT count(*) FROM materials"))
    if used:
        raise RuntimeError("Есть учебные материалы; откат — только через backup/restore.")
    op.execute("DROP TRIGGER materials_no_update ON materials")
    op.execute("DROP FUNCTION materials_immutable()")
    op.drop_table("material_assignment_receipts")
    op.drop_table("session_materials")
    op.drop_index("ix_materials_owner_id", table_name="materials")
    op.drop_table("materials")
