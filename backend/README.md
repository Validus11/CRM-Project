# CRM Backend

Flask + SQLAlchemy backend for the offline-first CRM described in
`SPEC-SHEET.md`. It now includes the PWA shell served by Flask, the
offline sync engine (push/pull, optimistic-concurrency conflict
detection, conflict resolution, audit log), plus CSV/JSON export/import
and SQLite backup/restore.

The frontend lives in `app/frontend.py`, `app/templates/`, and
`app/static/`.

## Data model

- **User** — Flask-Login auth. First registered user becomes `owner`.
- **Contact** — the core CRM record.
- **Tag** — many-to-many with Contact.
- **Interaction** — logged interactions (`occurred_at`) and scheduled
  future ones / reminders (`scheduled_at`, `is_completed`).
- **Setting** — per-user key/value store.
- **ConflictLog** — pending/resolved sync conflicts (both server and
  client versions preserved until resolved).
- **AuditLogEntry** — append-only log of every create/update/delete and
  every conflict detected/resolved.
- **SyncCursor** — tracks each user's last successful sync time.

Every syncable model (Contact, Tag, Interaction, Setting) carries:
`client_id` (client-generated UUID, for idempotent offline creates),
`version` (bumped on every write, used for conflict detection),
`updated_at`, and soft-delete fields (`is_deleted`, `deleted_at`).

## Running locally

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env   # edit SECRET_KEY etc.
export FLASK_ENV=development

flask --app run init-db     # or: flask --app run db upgrade, once migrations exist
flask --app run run
```

Run the smoke test (exercises the whole API surface against an in-memory DB):

```bash
FLASK_ENV=testing PYTHONPATH=. python3 tests/test_smoke.py
```

## Docker

```bash
cp backend/.env.example backend/.env   # edit SECRET_KEY
docker compose up --build
```

Works on Raspberry Pi (ARM64) and x86_64 unmodified — the `python:3.13-slim`
base image is multi-arch.

## API overview

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register`, `/login`, `/logout`, `GET /me` |
| Contacts | `GET/POST /api/contacts`, `GET/PUT/PATCH/DELETE /api/contacts/<id>`, `POST/DELETE /api/contacts/<id>/tags/<tag_id>` |
| Interactions | `GET/POST /api/contacts/<id>/interactions`, `GET /api/interactions/upcoming`, `PUT/PATCH/DELETE /api/interactions/<id>` |
| Tags | `GET/POST /api/tags`, `PUT/PATCH/DELETE /api/tags/<id>` |
| Settings | `GET /api/settings`, `PUT/DELETE /api/settings/<key>` |
| Sync | `POST /api/sync` (push batch), `GET /api/sync/pull?since=`, `GET /api/sync/status`, `GET /api/sync/conflicts`, `POST /api/sync/conflicts/<id>/resolve` |
| Data ownership | `GET /api/data/export/csv`, `/export/json`, `POST /api/data/import/csv`, `/import/json`, `POST /api/data/backup`, `GET /api/data/backups`, `POST /api/data/restore` |
| Misc | `GET /api/health`, `GET /api/audit` |

### How the sync engine works

The client keeps its own offline queue (IndexedDB) and, when connectivity
returns, POSTs it as an ordered array to `/api/sync`:

```json
{
  "device_label": "Elijah's phone",
  "changes": [
    {"op": "create", "entity_type": "contact", "client_id": "uuid-1", "payload": {"first_name": "Ada"}},
    {"op": "update", "entity_type": "contact", "entity_id": 42, "base_version": 3, "payload": {"notes": "..."}},
    {"op": "delete", "entity_type": "interaction", "entity_id": 7, "base_version": 1}
  ]
}
```

- Items are applied **in array order**, so a `create` for a contact and a
  later `update`/interaction referencing it in the same batch resolve
  correctly.
- `create` is idempotent on `client_id` — replaying a batch after a
  dropped response won't create duplicates.
- `update`/`delete` require `base_version` (the version the client last
  saw). If the server's current version has moved on, a `ConflictLog`
  row is created (both the server's current state and the client's
  attempted change are preserved) and the item comes back with
  `"status": "conflict"` instead of being applied.
- Conflicts are listed via `GET /api/sync/conflicts` and resolved with
  `POST /api/sync/conflicts/<id>/resolve` (`keep_server`, `keep_client`,
  or `merged` with a `merged_payload`). Every conflict and its resolution
  is written to the audit log.
- `GET /api/sync/pull?since=<iso timestamp>` returns everything changed
  since that time (omit `since` for the initial full sync) so the client
  can refresh its local cache after pushing.

## Not yet built

- Flask-Migrate migration scripts (currently `flask db init` hasn't been
  run — schema is created via `init-db` / `db.create_all()` for now)
- Background scheduled backups
- PostgreSQL-specific tuning (works today via `DATABASE_URL`, untested)
- Multi-user / role permissions beyond owner-vs-member on backup/restore
