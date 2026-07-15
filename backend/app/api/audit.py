from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user

from app.models import AuditLogEntry

bp = Blueprint("audit", __name__, url_prefix="/api/audit")


@bp.get("")
@login_required
def list_audit_entries():
    page = request.args.get("page", default=1, type=int)
    per_page = min(request.args.get("per_page", default=50, type=int), 200)

    query = AuditLogEntry.query.filter_by(user_id=current_user.id).order_by(AuditLogEntry.created_at.desc())
    pagination = query.paginate(page=page, per_page=per_page, error_out=False)

    return jsonify({
        "entries": [e.to_dict() for e in pagination.items],
        "page": pagination.page,
        "pages": pagination.pages,
        "total": pagination.total,
    })
