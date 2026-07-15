from app.extensions import db
from app.models.base import SyncableMixin
from app.models.tag import contact_tags


class Contact(SyncableMixin, db.Model):
    __tablename__ = "contacts"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)

    first_name = db.Column(db.String(120), nullable=False)
    last_name = db.Column(db.String(120), nullable=True)
    company = db.Column(db.String(200), nullable=True)
    job_title = db.Column(db.String(150), nullable=True)

    email = db.Column(db.String(255), nullable=True, index=True)
    phone = db.Column(db.String(50), nullable=True, index=True)

    address = db.Column(db.String(500), nullable=True)
    notes = db.Column(db.Text, nullable=True)

    tags = db.relationship("Tag", secondary=contact_tags, backref=db.backref("contacts", lazy="dynamic"))
    interactions = db.relationship(
        "Interaction", backref="contact", lazy="dynamic", cascade="all, delete-orphan"
    )

    def full_name(self):
        return " ".join(p for p in [self.first_name, self.last_name] if p)

    def to_dict(self, include_tags=True):
        data = {
            "id": self.id,
            "client_id": self.client_id,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "full_name": self.full_name(),
            "company": self.company,
            "job_title": self.job_title,
            "email": self.email,
            "phone": self.phone,
            "address": self.address,
            "notes": self.notes,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "version": self.version,
            "is_deleted": self.is_deleted,
        }
        if include_tags:
            data["tags"] = [t.to_dict() for t in self.tags]
        return data
