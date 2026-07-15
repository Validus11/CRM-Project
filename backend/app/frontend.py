from flask import Blueprint, current_app, render_template, send_from_directory


bp = Blueprint("frontend", __name__)


@bp.get("/")
def index():
    return render_template("index.html")


@bp.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(
        current_app.static_folder,
        "manifest.webmanifest",
        mimetype="application/manifest+json",
    )


@bp.get("/sw.js")
def service_worker():
    return send_from_directory(
        current_app.static_folder,
        "sw.js",
        mimetype="application/javascript",
    )