from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user

from app.extensions import db
from app.models import Setting
from app.utils.audit import record_audit

bp = Blueprint("settings", __name__, url_prefix="/api/settings")


@bp.get("")
@login_required
def list_settings():
    settings = Setting.query.filter_by(user_id=current_user.id, is_deleted=False).all()
    return jsonify({"settings": {s.key: s.value for s in settings}})


@bp.put("/<string:key>")
@login_required
def upsert_setting(key):
    data = request.get_json(silent=True) or {}
    value = data.get("value")

    setting = Setting.query.filter_by(user_id=current_user.id, key=key, is_deleted=False).first()
    if setting:
        setting.value = value
        setting.touch()
        action = "update"
    else:
        setting = Setting(user_id=current_user.id, key=key, value=value)
        db.session.add(setting)
        db.session.flush()
        action = "create"

    record_audit(current_user.id, action, "setting", setting.id, source="api")
    db.session.commit()
    return jsonify({"setting": setting.to_dict()})


@bp.delete("/<string:key>")
@login_required
def delete_setting(key):
    setting = Setting.query.filter_by(user_id=current_user.id, key=key, is_deleted=False).first()
    if not setting:
        return jsonify({"error": "not found"}), 404
    setting.soft_delete()
    record_audit(current_user.id, "delete", "setting", setting.id, source="api")
    db.session.commit()
    return jsonify({"ok": True})
