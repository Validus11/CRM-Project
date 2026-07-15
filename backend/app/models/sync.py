from app.extensions import db
from app.models.base import utcnow


class ConflictLog(db.Model):
    """Recorded whenever a queued offline change collides with a newer
    server-side version of the same record. Both versions are preserved
    (server version stays live; client's attempted version is stored here)
    until the user resolves it via /api/sync/conflicts/<id>/resolve.
    """

    __tablename__ = "conflict_logs"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)

    entity_type = db.Column(db.String(50), nullable=False)  # contact | interaction | tag | setting
    entity_id = db.Column(db.Integer, nullable=False)
    client_id = db.Column(db.String(36), nullable=True)

    server_version = db.Column(db.Integer, nullable=False)
    server_snapshot = db.Column(db.JSON, nullable=False)

    client_base_version = db.Column(db.Integer, nullable=False)  # version client thought it was editing
    client_payload = db.Column(db.JSON, nullable=False)  # the change client tried to apply

    status = db.Column(db.String(20), default="pending", nullable=False)  # pending | resolved
    resolution = db.Column(db.String(20), nullable=True)  # keep_server | keep_client | merged
    resolved_at = db.Column(db.DateTime(timezone=True), nullable=True)

    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "client_id": self.client_id,
            "server_version": self.server_version,
            "server_snapshot": self.server_snapshot,
            "client_base_version": self.client_base_version,
            "client_payload": self.client_payload,
            "status": self.status,
            "resolution": self.resolution,
            "created_at": self.created_at.isoformat(),
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
        }


class AuditLogEntry(db.Model):
    """Append-only log of every sync-related action: applied changes,
    detected conflicts, and how conflicts were resolved. Not user-editable.
    """

    __tablename__ = "audit_log"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)

    action = db.Column(db.String(50), nullable=False)  # create | update | delete | conflict_detected | conflict_resolved
    entity_type = db.Column(db.String(50), nullable=False)
    entity_id = db.Column(db.Integer, nullable=True)
    detail = db.Column(db.JSON, nullable=True)

    source = db.Column(db.String(20), default="sync", nullable=False)  # sync | api | system

    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "action": self.action,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "detail": self.detail,
            "source": self.source,
            "created_at": self.created_at.isoformat(),
        }


class SyncCursor(db.Model):
    """Tracks each user's last successful sync so the client knows what
    'last successful synchronisation' timestamp to display, and so the
    server can hand back only records changed since then on the next pull.
    """

    __tablename__ = "sync_cursors"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, unique=True, index=True)
    last_synced_at = db.Column(db.DateTime(timezone=True), nullable=True)
    device_label = db.Column(db.String(120), nullable=True)

    def to_dict(self):
        return {
            "last_synced_at": self.last_synced_at.isoformat() if self.last_synced_at else None,
            "device_label": self.device_label,
        }
