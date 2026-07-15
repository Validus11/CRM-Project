from app.extensions import db
from app.models.base import SyncableMixin


class Setting(SyncableMixin, db.Model):
    __tablename__ = "settings"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    key = db.Column(db.String(120), nullable=False)
    value = db.Column(db.Text, nullable=True)  # JSON-encoded on the client if needed

    __table_args__ = (
        db.UniqueConstraint("user_id", "key", name="uq_setting_user_key"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "client_id": self.client_id,
            "key": self.key,
            "value": self.value,
            "updated_at": self.updated_at.isoformat(),
            "version": self.version,
        }
