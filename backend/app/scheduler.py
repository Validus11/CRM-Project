import os
import shutil
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)


def _db_path(app):
    uri = app.config["SQLALCHEMY_DATABASE_URI"]
    if not uri.startswith("sqlite:///"):
        return None
    return uri.replace("sqlite:///", "", 1)


def _run_backup(app):
    with app.app_context():
        from app.extensions import db
        from app.utils.audit import record_audit
        from app.models import User

        path = _db_path(app)
        if not path or not os.path.exists(path):
            return  # automatic backups only support the built-in SQLite database

        backup_dir = app.config["BACKUP_DIR"]
        os.makedirs(backup_dir, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup_path = os.path.join(backup_dir, f"auto-{stamp}.db")

        db.session.commit()
        shutil.copy2(path, backup_path)
        logger.info("Automatic backup written to %s", backup_path)

        owner = User.query.filter_by(role="owner").first()
        if owner:
            record_audit(owner.id, "create", "backup", detail={"file": os.path.basename(backup_path), "auto": True}, source="system")
            db.session.commit()

        _enforce_retention(backup_dir, app.config.get("BACKUP_RETENTION", 14))


def _enforce_retention(backup_dir, keep):
    auto_backups = sorted(
        (f for f in os.listdir(backup_dir) if f.startswith("auto-")),
        reverse=True,
    )
    for stale in auto_backups[keep:]:
        try:
            os.remove(os.path.join(backup_dir, stale))
        except OSError:
            pass


def init_scheduled_backups(app):
    """Registers a recurring background job that snapshots the SQLite
    database. Interval and retention are configurable via env vars so a
    self-hosted instance can dial this in without a code change.
    Disabled automatically for the testing/in-memory-DB config.
    """
    if app.config.get("TESTING"):
        return None
    if not app.config.get("AUTO_BACKUP_ENABLED", True):
        return None

    interval_hours = app.config.get("BACKUP_INTERVAL_HOURS", 24)

    scheduler = BackgroundScheduler(daemon=True)
    scheduler.add_job(
        _run_backup,
        "interval",
        hours=interval_hours,
        args=[app],
        id="crm-auto-backup",
        next_run_time=datetime.now(),  # take one backup shortly after startup too
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    app.extensions["backup_scheduler"] = scheduler
    return scheduler
