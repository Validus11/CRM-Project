import os

from flask import Flask, jsonify
from werkzeug.middleware.proxy_fix import ProxyFix

from app.config import config_by_name
from app.extensions import db, login_manager, migrate, cors, limiter


def create_app(env=None):
    env = env or os.environ.get("FLASK_ENV", "production")
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(config_by_name.get(env, config_by_name["production"]))

    # Trust X-Forwarded-* headers from the reverse proxy in front of us
    # (Cloudflare Tunnel, Tailscale, nginx) so secure cookies and url_for
    # behave correctly even though the proxy talks to gunicorn over plain HTTP.
    hops = app.config.get("PROXY_HOP_COUNT", 1)
    if hops:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops, x_proto=hops, x_host=hops)

    db.init_app(app)
    migrate.init_app(app, db)
    login_manager.init_app(app)
    cors.init_app(app, supports_credentials=True, origins=app.config["CORS_ORIGINS"])
    limiter.init_app(app)

    from app.models import User

    @login_manager.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))

    @login_manager.unauthorized_handler
    def unauthorized():
        return jsonify({"error": "authentication required"}), 401

    from app.api import register_blueprints
    register_blueprints(app)

    from app import frontend
    app.register_blueprint(frontend.bp)

    from app.scheduler import init_scheduled_backups
    init_scheduled_backups(app)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    @app.errorhandler(404)
    def not_found(e):
        return jsonify({"error": "not found"}), 404

    @app.errorhandler(413)
    def too_large(e):
        return jsonify({"error": "payload too large"}), 413

    @app.errorhandler(429)
    def rate_limited(e):
        return jsonify({"error": "too many requests, slow down"}), 429

    @app.errorhandler(500)
    def server_error(e):
        return jsonify({"error": "internal server error"}), 500

    @app.after_request
    def set_security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        if app.config.get("SESSION_COOKIE_SECURE"):
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        # CSP is deliberately loose here since this app also serves the
        # PWA frontend (inline bootstrap, service worker); tighten once
        # the frontend build is finalised.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "connect-src 'self'; "
            "img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; "
            "manifest-src 'self'; "
            "worker-src 'self'; "
            "frame-ancestors 'none'"
        )
        return response

    return app
