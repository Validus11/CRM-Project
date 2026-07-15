from app.extensions import db
from app.models.base import SyncableMixin

INTERACTION_TYPES = ("call", "email", "meeting", "note", "task", "other")


class Interaction(SyncableMixin, db.Model):
    __tablename__ = "interactions"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    contact_id = db.Column(db.Integer, db.ForeignKey("contacts.id"), nullable=False, index=True)

    type = db.Column(db.String(20), default="note", nullable=False)
    subject = db.Column(db.String(200), nullable=True)
    body = db.Column(db.Text, nullable=True)

    # Set for a completed/logged interaction that already happened.
    occurred_at = db.Column(db.DateTime(timezone=True), nullable=True)

    # Set for a scheduled future interaction ("reminder").
    scheduled_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    is_completed = db.Column(db.Boolean, default=False, nullable=False)
    completed_at = db.Column(db.DateTime(timezone=True), nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "client_id": self.client_id,
            "contact_id": self.contact_id,
            "type": self.type,
            "subject": self.subject,
            "body": self.body,
            "occurred_at": self.occurred_at.isoformat() if self.occurred_at else None,
            "scheduled_at": self.scheduled_at.isoformat() if self.scheduled_at else None,
            "is_completed": self.is_completed,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "version": self.version,
            "is_deleted": self.is_deleted,
        }
