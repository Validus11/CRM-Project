from datetime import datetime

from app.models import Contact, Interaction, Tag, Setting


def _parse_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


CONTACT_FIELDS = ["first_name", "last_name", "company", "job_title", "email", "phone", "address", "notes"]
INTERACTION_FIELDS = ["contact_id", "type", "subject", "body"]
TAG_FIELDS = ["name", "color"]
SETTING_FIELDS = ["key", "value"]

# Registry used by the sync engine, and reusable for CSV/JSON import/export.
ENTITY_REGISTRY = {
    "contact": {
        "model": Contact,
        "fields": CONTACT_FIELDS,
        "datetime_fields": [],
    },
    "interaction": {
        "model": Interaction,
        "fields": INTERACTION_FIELDS,
        "datetime_fields": ["occurred_at", "scheduled_at", "completed_at"],
    },
    "tag": {
        "model": Tag,
        "fields": TAG_FIELDS,
        "datetime_fields": [],
    },
    "setting": {
        "model": Setting,
        "fields": SETTING_FIELDS,
        "datetime_fields": [],
    },
}


def apply_payload_to_instance(instance, payload, entity_type):
    """Copy allowed fields from a client payload onto a model instance,
    parsing any declared datetime fields."""
    spec = ENTITY_REGISTRY[entity_type]
    for field in spec["fields"]:
        if field in payload:
            setattr(instance, field, payload[field])
    for field in spec["datetime_fields"]:
        if field in payload:
            setattr(instance, field, _parse_dt(payload[field]))
    # is_completed/completed_at are interaction-only booleans not in FIELDS
    if entity_type == "interaction":
        if "is_completed" in payload:
            instance.is_completed = bool(payload["is_completed"])
        if "completed_at" in payload:
            instance.completed_at = _parse_dt(payload["completed_at"])
