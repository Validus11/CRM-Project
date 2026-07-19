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

# --- edit tag via sync (spec: "Edit tags" must be offline-queueable) ---
r = client.post("/api/sync", json={"changes": [
    {"op": "update", "entity_type": "tag", "entity_id": tag["id"],
     "base_version": tag["version"], "payload": {"name": "VIP-Renamed", "color": "#00ff00"}},
]})
assert r.status_code == 200, r.data
res = j(r)
assert res["applied"] == 1, res
assert res["results"][0]["server"]["name"] == "VIP-Renamed"
print("sync edit tag OK")

# --- edit interaction via sync (spec: "Edit interaction" must be offline-queueable) ---
r = client.post("/api/sync", json={"changes": [
    {"op": "update", "entity_type": "interaction", "entity_id": interaction["id"],
     "base_version": interaction["version"], "payload": {"subject": "Follow-up call", "is_completed": True}},
]})
assert r.status_code == 200, r.data
res = j(r)
assert res["applied"] == 1, res
assert res["results"][0]["server"]["subject"] == "Follow-up call"
assert res["results"][0]["server"]["is_completed"] is True
print("sync edit interaction OK")

# --- offline-dependency resolution: interaction created for a contact that
# hasn't synced yet, referenced only by contact_client_id (the reported bug) ---
offline_contact_client_id = "offline-contact-1"
r = client.post("/api/sync", json={"changes": [
    {"op": "create", "entity_type": "contact", "client_id": offline_contact_client_id,
     "payload": {"first_name": "Ada", "last_name": "Offline"}},
]})
assert r.status_code == 200, r.data
offline_contact_id = j(r)["results"][0]["server"]["id"]

r = client.post("/api/sync", json={"changes": [
    {"op": "create", "entity_type": "interaction", "client_id": "offline-interaction-1",
     "payload": {"contact_client_id": offline_contact_client_id, "type": "call", "subject": "First call"}},
]})
assert r.status_code == 200, r.data
res = j(r)
assert res["applied"] == 1, res
assert res["results"][0]["server"]["contact_id"] == offline_contact_id, res
print("offline contact -> offline interaction linkage OK")

# --- offline tag creation + attach to an offline contact, resolved via *_client_id ---
r = client.post("/api/sync", json={"changes": [
    {"op": "create", "entity_type": "tag", "client_id": "offline-tag-1", "payload": {"name": "Lead", "color": "#123456"}},
    {"op": "create", "entity_type": "contact_tag", "client_id": "offline-link-1",
     "payload": {"contact_client_id": offline_contact_client_id, "tag_client_id": "offline-tag-1"}},
]})
assert r.status_code == 200, r.data
res = j(r)
assert res["applied"] == 2, res
assert "Lead" in [t["name"] for t in res["results"][1]["server"]["tags"]], res
print("offline tag creation + attach-to-offline-contact OK")

print("\\nALL SMOKE TESTS PASSED")
