from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user

from app.extensions import db
from app.models import Tag
from app.utils.audit import record_audit

bp = Blueprint("tags", __name__, url_prefix="/api/tags")


@bp.get("")
@login_required
def list_tags():
    tags = Tag.query.filter_by(user_id=current_user.id, is_deleted=False).order_by(Tag.name.asc()).all()
    return jsonify({"tags": [t.to_dict() for t in tags]})


@bp.post("")
@login_required
def create_tag():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    existing = Tag.query.filter_by(user_id=current_user.id, name=name, is_deleted=False).first()
    if existing:
        return jsonify({"error": "a tag with that name already exists"}), 409

    tag = Tag(user_id=current_user.id, name=name, color=data.get("color", "#6c757d"))
    if data.get("client_id"):
        tag.client_id = data["client_id"]

    db.session.add(tag)
    db.session.flush()
    record_audit(current_user.id, "create", "tag", tag.id, source="api")
    db.session.commit()
    return jsonify({"tag": tag.to_dict()}), 201


@bp.put("/<int:tag_id>")
@bp.patch("/<int:tag_id>")
@login_required
def update_tag(tag_id):
    tag = Tag.query.filter_by(id=tag_id, user_id=current_user.id, is_deleted=False).first()
    if not tag:
        return jsonify({"error": "not found"}), 404

    data = request.get_json(silent=True) or {}
    expected_version = data.get("version")
    if expected_version is not None and int(expected_version) != tag.version:
        return jsonify({
            "error": "conflict",
            "message": "This tag was modified elsewhere. Refresh and try again.",
            "server_version": tag.to_dict(),
        }), 409
    if "name" in data and data["name"].strip():
        tag.name = data["name"].strip()
    if "color" in data:
        tag.color = data["color"]

    tag.touch()
    record_audit(current_user.id, "update", "tag", tag.id, source="api")
    db.session.commit()
    return jsonify({"tag": tag.to_dict()})


@bp.delete("/<int:tag_id>")
@login_required
def delete_tag(tag_id):
    tag = Tag.query.filter_by(id=tag_id, user_id=current_user.id, is_deleted=False).first()
    if not tag:
        return jsonify({"error": "not found"}), 404
    tag.soft_delete()
    record_audit(current_user.id, "delete", "tag", tag.id, source="api")
    db.session.commit()
    return jsonify({"ok": True})
