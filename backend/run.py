import os

from app import create_app
from app.extensions import db

app = create_app(os.environ.get("FLASK_ENV", "production"))


@app.cli.command("init-db")
def init_db():
    """Create all tables. For quick local setup; prefer flask-migrate
    (flask db upgrade) once the schema is under migration control."""
    with app.app_context():
        db.create_all()
    print("Database tables created.")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
