from datetime import datetime, timezone

from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user

from app.extensions import db
from app.models import ConflictLog, SyncCursor, Contact, Tag
from app.utils.audit import record_audit
from app.utils.sync_registry import ENTITY_REGISTRY, apply_payload_to_instance

bp = Blueprint("sync", __name__, url_prefix="/api/sync")

VALID_ENTITY_TYPES = set(ENTITY_REGISTRY.keys()) | {"contact_tag"}
VALID_OPS = {"create", "update", "delete"}

# Lets a payload reference another record that may itself still be sitting
# in the offline queue (e.g. an interaction created for a contact that
# hasn't synced yet). The client sends "<field>_client_id" instead of a
# real numeric id; we resolve it to the real id here, as long as that
# referenced record has already been processed (same request or earlier).
REF_RESOLVERS = {
    "contact_client_id": ("contact_id", Contact),
    "tag_client_id": ("tag_id", Tag),
}


def _resolve_client_refs(payload):
    """Mutates a copy of payload, replacing any *_client_id keys with the
    real numeric id of the referenced record. Returns (payload, error) -
    error is a message string if a referenced record can't be found yet
    (e.g. its own create is still queued behind this one client-side)."""
    resolved = dict(payload)
    for ref_key, (target_field, model) in REF_RESOLVERS.items():
        if ref_key not in resolved:
            continue
        client_id = resolved.pop(ref_key)
        record = model.query.filter_by(client_id=client_id, user_id=current_user.id, is_deleted=False).first()
        if not record:
            return None, f"referenced {model.__tablename__[:-1]} (client_id={client_id}) hasn't synced yet"
        resolved[target_field] = record.id
    return resolved, None


def _get_cursor():
    cursor = SyncCursor.query.filter_by(user_id=current_user.id).first()
    if not cursor:
        cursor = SyncCursor(user_id=current_user.id)
        db.session.add(cursor)
    return cursor


def _serialize(entity_type, instance):
    return instance.to_dict()


def _process_contact_tag(item):
    """Attach/detach a tag to a contact. Not a normal CRUD entity - it's a
    toggle on the many-to-many relationship - so it's handled separately
    from the generic ENTITY_REGISTRY dispatch below. Supports the same
    *_client_id resolution as everything else, so tagging a contact you
    just created offline (with a tag you also just created offline) works
    in one sync pass once both have been applied."""
    op = item.get("op")
    client_id = item.get("client_id")
    payload = item.get("payload") or {}

    if op not in ("create", "delete"):
        return {"client_id": client_id, "status": "error", "message": "contact_tag only supports create/delete"}

    resolved, error = _resolve_client_refs(payload)
    if error:
        return {"client_id": client_id, "status": "error", "message": error}

    contact_id = resolved.get("contact_id") or item.get("entity_id")
    tag_id = resolved.get("tag_id")
    if not contact_id or not tag_id:
        return {"client_id": client_id, "status": "error", "message": "contact_tag requires contact and tag references"}

    contact = Contact.query.filter_by(id=contact_id, user_id=current_user.id, is_deleted=False).first()
    tag = Tag.query.filter_by(id=tag_id, user_id=current_user.id, is_deleted=False).first()
    if not contact or not tag:
        return {"client_id": client_id, "status": "error", "message": "contact or tag not found"}

    if op == "create":
        if tag not in contact.tags:
            contact.tags.append(tag)
            contact.touch(bump_version=False)
            record_audit(current_user.id, "create", "contact_tag", contact.id, detail={"tag_id": tag.id})
    else:
        if tag in contact.tags:
            contact.tags.remove(tag)
            contact.touch(bump_version=False)
            record_audit(current_user.id, "delete", "contact_tag", contact.id, detail={"tag_id": tag.id})

    return {"client_id": client_id, "status": "applied", "server": contact.to_dict()}


def _process_item(item):
    """Apply a single queued change. Returns a result dict describing the
    outcome: applied / conflict / error. Chronological ordering is the
    caller's responsibility (the client queue is FIFO by nature; the
    server just processes the batch array in the order it was given).
    """
    op = item.get("op")
    entity_type = item.get("entity_type")
    client_id = item.get("client_id")
    payload = item.get("payload") or {}

    if op not in VALID_OPS or entity_type not in VALID_ENTITY_TYPES:
        return {"client_id": client_id, "status": "error", "message": "invalid op or entity_type"}

    if entity_type == "contact_tag":
        return _process_contact_tag(item)

    model = ENTITY_REGISTRY[entity_type]["model"]

    # --- CREATE ---
    if op == "create":
        if not client_id:
            return {"client_id": client_id, "status": "error", "message": "client_id required for create"}

        existing = model.query.filter_by(client_id=client_id, user_id=current_user.id).first()
        if existing:
            # Already synced previously (e.g. retried after a dropped
            # response) - idempotent no-op, just return current state.
            return {"client_id": client_id, "status": "applied", "server": _serialize(entity_type, existing)}

        payload, error = _resolve_client_refs(payload)
        if error:
            return {"client_id": client_id, "status": "error", "message": error}

        instance = model(user_id=current_user.id, client_id=client_id)
        apply_payload_to_instance(instance, payload, entity_type)
        db.session.add(instance)
        db.session.flush()
        record_audit(current_user.id, "create", entity_type, instance.id, detail={"client_id": client_id})
        return {"client_id": client_id, "status": "applied", "server": _serialize(entity_type, instance)}

    # --- UPDATE / DELETE need to locate the existing record ---
    entity_id = item.get("entity_id")
    instance = None
    if entity_id:
        instance = model.query.filter_by(id=entity_id, user_id=current_user.id).first()
    if not instance and client_id:
        instance = model.query.filter_by(client_id=client_id, user_id=current_user.id).first()

    if not instance:
        return {"client_id": client_id, "status": "error", "message": f"{entity_type} not found"}

    base_version = item.get("base_version")

    # --- CONFLICT DETECTION ---
    # The client must tell us which version it last saw (base_version).
    # If the server's current version has moved on since then, someone
    # else (or another device) changed the record in between - conflict.
    if base_version is not None and instance.version != base_version:
        conflict = ConflictLog(
            user_id=current_user.id,
            entity_type=entity_type,
            entity_id=instance.id,
            client_id=client_id,
            server_version=instance.version,
            server_snapshot=_serialize(entity_type, instance),
            client_base_version=base_version,
            client_payload=payload,
        )
        db.session.add(conflict)
        db.session.flush()
        record_audit(
            current_user.id, "conflict_detected", entity_type, instance.id,
            detail={"conflict_id": conflict.id},
        )
        return {
            "client_id": client_id,
            "status": "conflict",
            "conflict_id": conflict.id,
            "server": _serialize(entity_type, instance),
        }

    if op == "update":
        payload, error = _resolve_client_refs(payload)
        if error:
            return {"client_id": client_id, "status": "error", "message": error}
        apply_payload_to_instance(instance, payload, entity_type)
        instance.touch()
        record_audit(current_user.id, "update", entity_type, instance.id, detail={"client_id": client_id})
    elif op == "delete":
        instance.soft_delete()
        record_audit(current_user.id, "delete", entity_type, instance.id, detail={"client_id": client_id})

    return {"client_id": client_id, "status": "applied", "server": _serialize(entity_type, instance)}


@bp.post("")
@login_required
def push_sync_batch():
    """Accepts the client's offline queue as an ordered array of changes
    and applies them one by one, in the order received, so causally
    dependent edits (e.g. create-contact then add-interaction-to-it)
    resolve correctly.
    """
    data = request.get_json(silent=True) or {}
    changes = data.get("changes")
    device_label = data.get("device_label")

    if not isinstance(changes, list):
        return jsonify({"error": "changes must be a list"}), 400
    if len(changes) > 500:
        return jsonify({"error": "batch too large, split into multiple syncs"}), 413

    results = [_process_item(item) for item in changes]

    cursor = _get_cursor()
    cursor.last_synced_at = datetime.now(timezone.utc)
    if device_label:
        cursor.device_label = device_label

    db.session.commit()

    conflicts = [r for r in results if r["status"] == "conflict"]
    return jsonify({
        "results": results,
        "applied": sum(1 for r in results if r["status"] == "applied"),
        "conflicts": len(conflicts),
        "errors": sum(1 for r in results if r["status"] == "error"),
        "last_synced_at": cursor.last_synced_at.isoformat(),
    })


@bp.get("/pull")
@login_required
def pull_changes():
    """Returns everything changed since `since` (ISO timestamp) so the
    client can refresh its local IndexedDB cache. Omit `since` for a
    full initial sync.
    """
    since_raw = request.args.get("since")
    since = None
    if since_raw:
        since = datetime.fromisoformat(since_raw.replace("Z", "+00:00"))

    plural = {"contact": "contacts", "interaction": "interactions", "tag": "tags", "setting": "settings"}

    out = {}
    for entity_type, spec in ENTITY_REGISTRY.items():
        model = spec["model"]
        query = model.query.filter_by(user_id=current_user.id)
        if since:
            query = query.filter(model.updated_at > since)
        out[plural[entity_type]] = [r.to_dict() for r in query.all()]

    return jsonify({
        "data": out,
        "server_time": datetime.now(timezone.utc).isoformat(),
    })


@bp.get("/status")
@login_required
def sync_status():
    cursor = SyncCursor.query.filter_by(user_id=current_user.id).first()
    pending_conflicts = ConflictLog.query.filter_by(user_id=current_user.id, status="pending").count()
    return jsonify({
        "last_synced_at": cursor.last_synced_at.isoformat() if cursor and cursor.last_synced_at else None,
        "pending_conflicts": pending_conflicts,
    })


@bp.get("/conflicts")
@login_required
def list_conflicts():
    status = request.args.get("status", "pending")
    query = ConflictLog.query.filter_by(user_id=current_user.id)
    if status != "all":
        query = query.filter_by(status=status)
    conflicts = query.order_by(ConflictLog.created_at.desc()).all()
    return jsonify({"conflicts": [c.to_dict() for c in conflicts]})


@bp.post("/conflicts/<int:conflict_id>/resolve")
@login_required
def resolve_conflict(conflict_id):
    conflict = ConflictLog.query.filter_by(id=conflict_id, user_id=current_user.id).first()
    if not conflict:
        return jsonify({"error": "not found"}), 404
    if conflict.status == "resolved":
        return jsonify({"error": "already resolved"}), 409

    data = request.get_json(silent=True) or {}
    resolution = data.get("resolution")
    if resolution not in ("keep_server", "keep_client", "merged"):
        return jsonify({"error": "resolution must be keep_server, keep_client, or merged"}), 400

    model = ENTITY_REGISTRY[conflict.entity_type]["model"]
    instance = model.query.filter_by(id=conflict.entity_id, user_id=current_user.id).first()
    if not instance:
        return jsonify({"error": "underlying record no longer exists"}), 410

    if resolution == "keep_server":
        pass  # nothing to do, server copy already live
    elif resolution == "keep_client":
        apply_payload_to_instance(instance, conflict.client_payload, conflict.entity_type)
        instance.touch()
    elif resolution == "merged":
        merged_payload = data.get("merged_payload")
        if not isinstance(merged_payload, dict):
            return jsonify({"error": "merged_payload object required for a merged resolution"}), 400
        apply_payload_to_instance(instance, merged_payload, conflict.entity_type)
        instance.touch()

    conflict.status = "resolved"
    conflict.resolution = resolution
    conflict.resolved_at = datetime.now(timezone.utc)

    record_audit(
        current_user.id, "conflict_resolved", conflict.entity_type, instance.id,
        detail={"conflict_id": conflict.id, "resolution": resolution},
    )
    db.session.commit()
    return jsonify({"conflict": conflict.to_dict(), "server": _serialize(conflict.entity_type, instance)})
