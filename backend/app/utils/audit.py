from app.extensions import db
from app.models.sync import AuditLogEntry


def record_audit(user_id, action, entity_type, entity_id=None, detail=None, source="sync"):
    entry = AuditLogEntry(
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        detail=detail,
        source=source,
    )
    db.session.add(entry)
    return entry
