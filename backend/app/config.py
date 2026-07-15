import os
from datetime import timedelta

basedir = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
instance_dir = os.path.join(basedir, "instance")
os.makedirs(instance_dir, exist_ok=True)


class Config:
    """Base configuration. Values are overridden by environment variables
    so the same image can be deployed via Docker Compose on a Pi, x86_64
    box, or behind a Cloudflare Tunnel without rebuilding."""

    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")

    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL", f"sqlite:///{os.path.join(instance_dir, 'crm.db')}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}

    # Where SQLite backups are written (Data Ownership: one-click backup/restore)
    BACKUP_DIR = os.environ.get("BACKUP_DIR", os.path.join(instance_dir, "backups"))

    # Session / cookie hardening for public deployment
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "true").lower() == "true"
    PERMANENT_SESSION_LIFETIME = timedelta(days=14)
    REMEMBER_COOKIE_DURATION = timedelta(days=30)
    REMEMBER_COOKIE_HTTPONLY = True
    REMEMBER_COOKIE_SECURE = SESSION_COOKIE_SECURE

    # CORS - the PWA frontend may be served from a different origin during dev
    CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*")

    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB, covers CSV/JSON import + avatars

    JSON_SORT_KEYS = False


class DevelopmentConfig(Config):
    DEBUG = True
    SESSION_COOKIE_SECURE = False
    REMEMBER_COOKIE_SECURE = False


class ProductionConfig(Config):
    DEBUG = False


class TestingConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SESSION_COOKIE_SECURE = False
    WTF_CSRF_ENABLED = False


config_by_name = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "testing": TestingConfig,
}
