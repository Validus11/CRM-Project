import uuid
from datetime import datetime, timezone

from app.extensions import db


def utcnow():
    return datetime.now(timezone.utc)


def gen_uuid():
    return str(uuid.uuid4())


class SyncableMixin:
    """Mixin for any model that can be created/edited offline and later
    synced. Provides the fields the sync engine needs to detect conflicts
    (updated_at + version) and to reconcile client-generated records
    (client_id) without creating duplicates when a queued 'create' is
    finally uploaded.
    """

    id = db.Column(db.Integer, primary_key=True)
    client_id = db.Column(db.String(36), unique=True, index=True, default=gen_uuid, nullable=False)

    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    # Bumped on every server-side write; used for optimistic-concurrency
    # conflict detection during sync (client must send the version it last saw).
    version = db.Column(db.Integer, default=1, nullable=False)

    is_deleted = db.Column(db.Boolean, default=False, nullable=False)
    deleted_at = db.Column(db.DateTime(timezone=True), nullable=True)

    def touch(self, bump_version=True):
        self.updated_at = utcnow()
        if bump_version:
            self.version = (self.version or 0) + 1

    def soft_delete(self):
        self.is_deleted = True
        self.deleted_at = utcnow()
        self.touch()
