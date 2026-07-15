from app.extensions import db
from app.models.base import SyncableMixin


class Tag(SyncableMixin, db.Model):
    __tablename__ = "tags"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    name = db.Column(db.String(80), nullable=False)
    color = db.Column(db.String(7), default="#6c757d")  # hex color for UI chips

    __table_args__ = (
        db.UniqueConstraint("user_id", "name", name="uq_tag_user_name"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "client_id": self.client_id,
            "name": self.name,
            "color": self.color,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "version": self.version,
        }


contact_tags = db.Table(
    "contact_tags",
    db.Column("contact_id", db.Integer, db.ForeignKey("contacts.id"), primary_key=True),
    db.Column("tag_id", db.Integer, db.ForeignKey("tags.id"), primary_key=True),
)
