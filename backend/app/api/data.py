import csv
import io
import json
import os
import shutil
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify, send_file, current_app
from flask_login import login_required, current_user

from app.extensions import db
from app.models import Contact, Tag
from app.utils.audit import record_audit

bp = Blueprint("data", __name__, url_prefix="/api/data")

CSV_COLUMNS = ["first_name", "last_name", "company", "job_title", "email", "phone", "address", "notes", "tags"]


# ---------- CSV ----------

@bp.get("/export/csv")
@login_required
def export_csv():
    contacts = Contact.query.filter_by(user_id=current_user.id, is_deleted=False).all()

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    for c in contacts:
        writer.writerow({
            "first_name": c.first_name,
            "last_name": c.last_name or "",
            "company": c.company or "",
            "job_title": c.job_title or "",
            "email": c.email or "",
            "phone": c.phone or "",
            "address": c.address or "",
            "notes": (c.notes or "").replace("\n", "\\n"),
            "tags": ";".join(t.name for t in c.tags),
        })

    mem = io.BytesIO(buf.getvalue().encode("utf-8"))
    mem.seek(0)
    filename = f"contacts-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.csv"
    return send_file(mem, mimetype="text/csv", as_attachment=True, download_name=filename)


@bp.post("/import/csv")
@login_required
def import_csv():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "file is required (multipart field 'file')"}), 400

    stream = io.StringIO(file.stream.read().decode("utf-8"))
    reader = csv.DictReader(stream)

    created, skipped = 0, 0
    for row in reader:
        first_name = (row.get("first_name") or "").strip()
        if not first_name:
            skipped += 1
            continue

        contact = Contact(
            user_id=current_user.id,
            first_name=first_name,
            last_name=(row.get("last_name") or "").strip() or None,
            company=(row.get("company") or "").strip() or None,
            job_title=(row.get("job_title") or "").strip() or None,
            email=(row.get("email") or "").strip() or None,
            phone=(row.get("phone") or "").strip() or None,
            address=(row.get("address") or "").strip() or None,
            notes=(row.get("notes") or "").replace("\\n", "\n") or None,
        )
        db.session.add(contact)
        db.session.flush()

        tag_names = [t.strip() for t in (row.get("tags") or "").split(";") if t.strip()]
        for name in tag_names:
            tag = Tag.query.filter_by(user_id=current_user.id, name=name, is_deleted=False).first()
            if not tag:
                tag = Tag(user_id=current_user.id, name=name)
                db.session.add(tag)
                db.session.flush()
            contact.tags.append(tag)

        created += 1

    record_audit(current_user.id, "create", "contact", detail={"import": "csv", "count": created}, source="api")
    db.session.commit()
    return jsonify({"created": created, "skipped": skipped})


# ---------- JSON ----------

@bp.get("/export/json")
@login_required
def export_json():
    contacts = Contact.query.filter_by(user_id=current_user.id, is_deleted=False).all()
    payload = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "contacts": [
            {**c.to_dict(), "interactions": [i.to_dict() for i in c.interactions.filter_by(is_deleted=False)]}
            for c in contacts
        ],
    }
    mem = io.BytesIO(json.dumps(payload, indent=2).encode("utf-8"))
    mem.seek(0)
    filename = f"crm-export-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    return send_file(mem, mimetype="application/json", as_attachment=True, download_name=filename)


@bp.post("/import/json")
@login_required
def import_json():
    data = request.get_json(silent=True)
    if not data or "contacts" not in data:
        return jsonify({"error": "expected a JSON object with a 'contacts' array"}), 400

    created = 0
    for item in data["contacts"]:
        first_name = (item.get("first_name") or "").strip()
        if not first_name:
            continue
        contact = Contact(
            user_id=current_user.id,
            first_name=first_name,
            last_name=item.get("last_name"),
            company=item.get("company"),
            job_title=item.get("job_title"),
            email=item.get("email"),
            phone=item.get("phone"),
            address=item.get("address"),
            notes=item.get("notes"),
        )
        db.session.add(contact)
        db.session.flush()

        for tag_data in item.get("tags", []):
            name = tag_data.get("name") if isinstance(tag_data, dict) else tag_data
            if not name:
                continue
            tag = Tag.query.filter_by(user_id=current_user.id, name=name, is_deleted=False).first()
            if not tag:
                tag = Tag(user_id=current_user.id, name=name)
                db.session.add(tag)
                db.session.flush()
            contact.tags.append(tag)

        created += 1

    record_audit(current_user.id, "create", "contact", detail={"import": "json", "count": created}, source="api")
    db.session.commit()
    return jsonify({"created": created})


# ---------- Full SQLite backup / restore ----------
# Only the instance owner may back up or restore the whole database, since
# restore affects every user's data on a self-hosted single-tenant instance.

def _db_path():
    uri = current_app.config["SQLALCHEMY_DATABASE_URI"]
    if not uri.startswith("sqlite:///"):
        return None
    return uri.replace("sqlite:///", "", 1)


@bp.post("/backup")
@login_required
def create_backup():
    if current_user.role != "owner":
        return jsonify({"error": "only the instance owner can create backups"}), 403

    path = _db_path()
    if not path or not os.path.exists(path):
        return jsonify({"error": "automatic backup is only supported for the built-in SQLite database"}), 400

    backup_dir = current_app.config["BACKUP_DIR"]
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.join(backup_dir, f"crm-backup-{stamp}.db")

    db.session.commit()  # flush any pending writes before copying the file
    shutil.copy2(path, backup_path)

    record_audit(current_user.id, "create", "backup", detail={"file": os.path.basename(backup_path)}, source="api")
    db.session.commit()

    return send_file(backup_path, as_attachment=True, download_name=os.path.basename(backup_path))


@bp.get("/backups")
@login_required
def list_backups():
    if current_user.role != "owner":
        return jsonify({"error": "only the instance owner can view backups"}), 403
    backup_dir = current_app.config["BACKUP_DIR"]
    if not os.path.isdir(backup_dir):
        return jsonify({"backups": []})
    files = sorted(os.listdir(backup_dir), reverse=True)
    return jsonify({"backups": files})


@bp.post("/restore")
@login_required
def restore_backup():
    """One-click restore: upload a previously downloaded .db backup file
    (or reference one already sitting in BACKUP_DIR via ?filename=) and it
    replaces the live database. The current live DB is itself backed up
    first so a bad restore can be undone.
    """
    if current_user.role != "owner":
        return jsonify({"error": "only the instance owner can restore backups"}), 403

    path = _db_path()
    if not path:
        return jsonify({"error": "restore is only supported for the built-in SQLite database"}), 400

    backup_dir = current_app.config["BACKUP_DIR"]
    os.makedirs(backup_dir, exist_ok=True)

    filename = request.args.get("filename")
    upload = request.files.get("file")

    if upload:
        safe_restore_source = os.path.join(backup_dir, f"_incoming_{upload.filename}")
        upload.save(safe_restore_source)
    elif filename:
        candidate = os.path.join(backup_dir, os.path.basename(filename))
        if not os.path.exists(candidate):
            return jsonify({"error": "backup file not found"}), 404
        safe_restore_source = candidate
    else:
        return jsonify({"error": "provide either an uploaded file or ?filename= of an existing backup"}), 400

    # Safety copy of current state before overwriting.
    pre_restore_stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    pre_restore_path = os.path.join(backup_dir, f"pre-restore-{pre_restore_stamp}.db")
    db.session.commit()
    shutil.copy2(path, pre_restore_path)

    db.session.remove()
    db.engine.dispose()
    shutil.copy2(safe_restore_source, path)

    return jsonify({
        "ok": True,
        "message": "Database restored. Please log in again.",
        "pre_restore_backup": os.path.basename(pre_restore_path),
    })
