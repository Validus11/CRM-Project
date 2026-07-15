from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user
from sqlalchemy import or_

from app.extensions import db
from app.models import Contact, Tag
from app.utils.audit import record_audit

bp = Blueprint("contacts", __name__, url_prefix="/api/contacts")


def _get_owned_contact(contact_id):
    return Contact.query.filter_by(id=contact_id, user_id=current_user.id, is_deleted=False).first()


@bp.get("")
@login_required
def list_contacts():
    q = request.args.get("q", "").strip()
    tag_id = request.args.get("tag_id", type=int)
    page = request.args.get("page", default=1, type=int)
    per_page = min(request.args.get("per_page", default=25, type=int), 100)

    query = Contact.query.filter_by(user_id=current_user.id, is_deleted=False)

    if q:
        like = f"%{q}%"
        query = query.filter(
            or_(
                Contact.first_name.ilike(like),
                Contact.last_name.ilike(like),
                Contact.company.ilike(like),
                Contact.email.ilike(like),
                Contact.phone.ilike(like),
                Contact.notes.ilike(like),
            )
        )
    if tag_id:
        query = query.filter(Contact.tags.any(Tag.id == tag_id))

    query = query.order_by(Contact.updated_at.desc())
    pagination = query.paginate(page=page, per_page=per_page, error_out=False)

    return jsonify({
        "contacts": [c.to_dict() for c in pagination.items],
        "page": pagination.page,
        "per_page": pagination.per_page,
        "total": pagination.total,
        "pages": pagination.pages,
    })


@bp.get("/<int:contact_id>")
@login_required
def get_contact(contact_id):
    contact = _get_owned_contact(contact_id)
    if not contact:
        return jsonify({"error": "not found"}), 404
    return jsonify({"contact": contact.to_dict()})


@bp.post("")
@login_required
def create_contact():
    data = request.get_json(silent=True) or {}
    if not (data.get("first_name") or "").strip():
        return jsonify({"error": "first_name is required"}), 400

    contact = Contact(
        user_id=current_user.id,
        first_name=data["first_name"].strip(),
        last_name=(data.get("last_name") or "").strip() or None,
        company=(data.get("company") or "").strip() or None,
        job_title=(data.get("job_title") or "").strip() or None,
        email=(data.get("email") or "").strip() or None,
        phone=(data.get("phone") or "").strip() or None,
        address=(data.get("address") or "").strip() or None,
        notes=data.get("notes"),
    )
    if data.get("client_id"):
        contact.client_id = data["client_id"]

    db.session.add(contact)
    db.session.flush()
    record_audit(current_user.id, "create", "contact", contact.id, source="api")
    db.session.commit()
    return jsonify({"contact": contact.to_dict()}), 201


@bp.put("/<int:contact_id>")
@bp.patch("/<int:contact_id>")
@login_required
def update_contact(contact_id):
    contact = _get_owned_contact(contact_id)
    if not contact:
        return jsonify({"error": "not found"}), 404

    data = request.get_json(silent=True) or {}

    # Optimistic concurrency check for online edits too, so a stale tab
    # doesn't silently clobber a newer edit made from another device.
    expected_version = data.get("version")
    if expected_version is not None and int(expected_version) != contact.version:
        return jsonify({
            "error": "conflict",
            "message": "This contact was modified elsewhere. Refresh and try again.",
            "server_version": contact.to_dict(),
        }), 409

    for field in ["first_name", "last_name", "company", "job_title", "email", "phone", "address", "notes"]:
        if field in data:
            setattr(contact, field, data[field])

    contact.touch()
    record_audit(current_user.id, "update", "contact", contact.id, source="api")
    db.session.commit()
    return jsonify({"contact": contact.to_dict()})


@bp.delete("/<int:contact_id>")
@login_required
def delete_contact(contact_id):
    contact = _get_owned_contact(contact_id)
    if not contact:
        return jsonify({"error": "not found"}), 404
    contact.soft_delete()
    record_audit(current_user.id, "delete", "contact", contact.id, source="api")
    db.session.commit()
    return jsonify({"ok": True})


@bp.post("/<int:contact_id>/tags/<int:tag_id>")
@login_required
def add_tag(contact_id, tag_id):
    contact = _get_owned_contact(contact_id)
    tag = Tag.query.filter_by(id=tag_id, user_id=current_user.id, is_deleted=False).first()
    if not contact or not tag:
        return jsonify({"error": "not found"}), 404
    if tag not in contact.tags:
        contact.tags.append(tag)
        contact.touch(bump_version=False)
        db.session.commit()
    return jsonify({"contact": contact.to_dict()})


@bp.delete("/<int:contact_id>/tags/<int:tag_id>")
@login_required
def remove_tag(contact_id, tag_id):
    contact = _get_owned_contact(contact_id)
    tag = Tag.query.filter_by(id=tag_id, user_id=current_user.id).first()
    if not contact or not tag:
        return jsonify({"error": "not found"}), 404
    if tag in contact.tags:
        contact.tags.remove(tag)
        contact.touch(bump_version=False)
        db.session.commit()
    return jsonify({"contact": contact.to_dict()})
