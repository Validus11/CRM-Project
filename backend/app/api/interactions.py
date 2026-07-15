from datetime import datetime, timezone

from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user

from app.extensions import db
from app.models import Contact, Interaction
from app.utils.audit import record_audit
from app.utils.sync_registry import _parse_dt

bp = Blueprint("interactions", __name__, url_prefix="/api")


def _owned_contact(contact_id):
    return Contact.query.filter_by(id=contact_id, user_id=current_user.id, is_deleted=False).first()


def _owned_interaction(interaction_id):
    return Interaction.query.filter_by(id=interaction_id, user_id=current_user.id, is_deleted=False).first()


@bp.get("/contacts/<int:contact_id>/interactions")
@login_required
def list_contact_interactions(contact_id):
    if not _owned_contact(contact_id):
        return jsonify({"error": "not found"}), 404
    interactions = (
        Interaction.query.filter_by(contact_id=contact_id, user_id=current_user.id, is_deleted=False)
        .order_by(Interaction.occurred_at.desc().nullslast(), Interaction.scheduled_at.asc().nullslast())
        .all()
    )
    return jsonify({"interactions": [i.to_dict() for i in interactions]})


@bp.get("/interactions/upcoming")
@login_required
def upcoming_interactions():
    """Scheduled future interactions (reminders) not yet completed."""
    now = datetime.now(timezone.utc)
    interactions = (
        Interaction.query.filter(
            Interaction.user_id == current_user.id,
            Interaction.is_deleted.is_(False),
            Interaction.is_completed.is_(False),
            Interaction.scheduled_at.isnot(None),
            Interaction.scheduled_at >= now,
        )
        .order_by(Interaction.scheduled_at.asc())
        .all()
    )
    return jsonify({"interactions": [i.to_dict() for i in interactions]})


@bp.post("/contacts/<int:contact_id>/interactions")
@login_required
def create_interaction(contact_id):
    if not _owned_contact(contact_id):
        return jsonify({"error": "not found"}), 404

    data = request.get_json(silent=True) or {}
    interaction = Interaction(
        user_id=current_user.id,
        contact_id=contact_id,
        type=data.get("type", "note"),
        subject=data.get("subject"),
        body=data.get("body"),
        occurred_at=_parse_dt(data.get("occurred_at")),
        scheduled_at=_parse_dt(data.get("scheduled_at")),
    )
    if data.get("client_id"):
        interaction.client_id = data["client_id"]

    db.session.add(interaction)
    db.session.flush()
    record_audit(current_user.id, "create", "interaction", interaction.id, source="api")
    db.session.commit()
    return jsonify({"interaction": interaction.to_dict()}), 201


@bp.put("/interactions/<int:interaction_id>")
@bp.patch("/interactions/<int:interaction_id>")
@login_required
def update_interaction(interaction_id):
    interaction = _owned_interaction(interaction_id)
    if not interaction:
        return jsonify({"error": "not found"}), 404

    data = request.get_json(silent=True) or {}
    expected_version = data.get("version")
    if expected_version is not None and int(expected_version) != interaction.version:
        return jsonify({
            "error": "conflict",
            "message": "This interaction was modified elsewhere.",
            "server_version": interaction.to_dict(),
        }), 409

    for field in ["type", "subject", "body"]:
        if field in data:
            setattr(interaction, field, data[field])
    for field in ["occurred_at", "scheduled_at", "completed_at"]:
        if field in data:
            setattr(interaction, field, _parse_dt(data[field]))
    if "is_completed" in data:
        interaction.is_completed = bool(data["is_completed"])
        if interaction.is_completed and not interaction.completed_at:
            interaction.completed_at = datetime.now(timezone.utc)

    interaction.touch()
    record_audit(current_user.id, "update", "interaction", interaction.id, source="api")
    db.session.commit()
    return jsonify({"interaction": interaction.to_dict()})


@bp.delete("/interactions/<int:interaction_id>")
@login_required
def delete_interaction(interaction_id):
    interaction = _owned_interaction(interaction_id)
    if not interaction:
        return jsonify({"error": "not found"}), 404
    interaction.soft_delete()
    record_audit(current_user.id, "delete", "interaction", interaction.id, source="api")
    db.session.commit()
    return jsonify({"ok": True})
