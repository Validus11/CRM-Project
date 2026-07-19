import os

from app import create_app
from app.extensions import db

app = create_app(os.environ.get("FLASK_ENV", "production"))


def ensure_database():
    with app.app_context():
        db.create_all()


@app.cli.command("init-db")
def init_db():
    """Create all tables. For quick local setup; prefer flask-migrate
    (flask db upgrade) once the schema is under migration control."""
    ensure_database()
    print("Database tables created.")


if __name__ == "__main__":
    ensure_database()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
