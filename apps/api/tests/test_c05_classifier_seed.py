"""C-05: повторный seed приводит справочник к редакции артефакта (046_24), не смешивая редакции."""

from uuid import uuid4

from app.core.contracts import read_json
from app.core.models import IncidentType, RoutingRule
from app.seed.loader import seed
from sqlalchemy import func, select

from .test_c03_migration import migrate
from .test_lifecycle import run_db

CLASSIFIER = read_json("data/classifier.json")


def test_reseed_replaces_rules_of_previous_edition(migration_database_url):
    url = migration_database_url
    migrate(url, "head")
    run_db(url, lambda db: seed(db, "test-password", include_training=False))
    stale_id = uuid4()

    async def simulate_old_edition(db):
        # Правило прежней редакции (без trigger) и устаревшее название типа.
        db.add(
            RoutingRule(
                id=stale_id,
                incident_type_code="13010200",
                service_id="101",
                condition={"kind": "classifier_column", "column": 14, "label": "старое"},
                payload="старое правило 046_11",
            )
        )
        incident = await db.get(IncidentType, "13010200")
        incident.name = incident.name.replace("тоннеле", "тонелле")

    run_db(url, simulate_old_edition)
    run_db(url, lambda db: seed(db, "test-password", include_training=False))

    async def verify(db):
        assert await db.get(RoutingRule, stale_id) is None
        count = await db.scalar(select(func.count()).select_from(RoutingRule))
        assert count == len(CLASSIFIER["routing_rules"]) == 3835
        assert await db.scalar(select(func.count()).select_from(IncidentType)) == 1283
        assert "тоннеле" in (await db.get(IncidentType, "13010200")).name
        triggers = set(await db.scalars(select(RoutingRule.condition["trigger"].astext)))
        assert triggers <= {
            "default",
            "no_access",
            "offense",
            "victims",
            "victims_off_site",
            "gasification",
        }

    run_db(url, verify)
