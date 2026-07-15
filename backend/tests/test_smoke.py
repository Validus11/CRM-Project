import json
from app import create_app
from app.extensions import db

app = create_app("testing")

with app.app_context():
    db.create_all()

client = app.test_client()

def j(resp):
    return resp.get_json()

# --- register / login ---
r = client.post("/api/auth/register", json={"email": "e@example.com", "password": "password123", "name": "Elijah"})
assert r.status_code == 201, r.data
print("register OK", j(r)["user"]["role"])

r = client.get("/api/auth/me")
assert r.status_code == 200, r.data
print("me OK")

# --- contacts ---
r = client.post("/api/contacts", json={"first_name": "Ada", "last_name": "Lovelace", "email": "ada@x.com"})
assert r.status_code == 201, r.data
contact = j(r)["contact"]
print("create contact OK", contact["id"], contact["version"])

r = client.get("/api/contacts?q=Ada")
assert r.status_code == 200 and j(r)["total"] == 1, r.data
print("search contact OK")

# --- tags ---
r = client.post("/api/tags", json={"name": "VIP", "color": "#ff0000"})
assert r.status_code == 201, r.data
tag = j(r)["tag"]
print("create tag OK", tag["id"])

r = client.post(f"/api/contacts/{contact['id']}/tags/{tag['id']}")
assert r.status_code == 200, r.data
assert j(r)["contact"]["tags"][0]["name"] == "VIP"
print("attach tag OK")

# --- interactions ---
r = client.post(f"/api/contacts/{contact['id']}/interactions", json={
    "type": "call", "subject": "Intro call", "scheduled_at": "2026-08-01T10:00:00+00:00"
})
assert r.status_code == 201, r.data
interaction = j(r)["interaction"]
print("create interaction OK", interaction["id"])

r = client.get("/api/interactions/upcoming")
assert r.status_code == 200 and len(j(r)["interactions"]) == 1, r.data
print("upcoming interactions OK")

# --- optimistic concurrency conflict on direct API update ---
r = client.put(f"/api/contacts/{contact['id']}", json={"first_name": "Ada2", "version": contact["version"] + 5})
assert r.status_code == 409, r.data
print("direct-API version conflict detection OK")

# --- offline sync push: create via sync with client_id ---
r = client.post("/api/sync", json={
    "changes": [
        {"op": "create", "entity_type": "contact", "client_id": "c-abc-123",
         "payload": {"first_name": "Grace", "last_name": "Hopper"}},
    ],
    "device_label": "test-device",
})
assert r.status_code == 200, r.data
res = j(r)
assert res["applied"] == 1, res
grace = res["results"][0]["server"]
print("sync create OK", grace["id"], grace["version"])

# retry same create (idempotency by client_id)
r = client.post("/api/sync", json={"changes": [
    {"op": "create", "entity_type": "contact", "client_id": "c-abc-123",
     "payload": {"first_name": "Grace", "last_name": "Hopper"}},
]})
assert r.status_code == 200
assert j(r)["applied"] == 1
print("sync create idempotency OK")

# --- sync update with stale base_version -> conflict ---
r = client.post("/api/sync", json={"changes": [
    {"op": "update", "entity_type": "contact", "entity_id": grace["id"],
     "base_version": 999, "payload": {"first_name": "Grace2"}},
]})
assert r.status_code == 200
res = j(r)
assert res["conflicts"] == 1, res
conflict_id = res["results"][0]["conflict_id"]
print("sync conflict detection OK", conflict_id)

r = client.get("/api/sync/conflicts")
assert r.status_code == 200 and len(j(r)["conflicts"]) == 1
print("list conflicts OK")

r = client.post(f"/api/sync/conflicts/{conflict_id}/resolve", json={"resolution": "keep_client"})
assert r.status_code == 200, r.data
print("resolve conflict OK ->", j(r)["server"]["first_name"])

# --- pull ---
r = client.get("/api/sync/pull")
assert r.status_code == 200
pulled = j(r)["data"]
assert len(pulled["contacts"]) == 2
print("pull OK, contacts:", len(pulled["contacts"]))

# --- status ---
r = client.get("/api/sync/status")
assert r.status_code == 200
print("sync status OK", j(r))

# --- export ---
r = client.get("/api/data/export/csv")
assert r.status_code == 200
print("CSV export OK, bytes:", len(r.data))

r = client.get("/api/data/export/json")
assert r.status_code == 200
print("JSON export OK, bytes:", len(r.data))

# --- audit log ---
r = client.get("/api/audit")
assert r.status_code == 200
print("audit log entries:", j(r)["total"])

print("\\nALL SMOKE TESTS PASSED")
