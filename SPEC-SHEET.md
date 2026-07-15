## 10. Offline-First Architecture

The application should be designed as an **offline-first Progressive Web App (PWA)**.

### Offline Behaviour

The application should continue to function normally when there is no internet connection or when the server is temporarily unavailable.

Features available while offline should include:

* View contacts
* Search contacts
* Add contacts
* Edit contacts
* Delete contacts
* Add interaction records
* Schedule future interactions
* Edit notes
* Manage tags

### Local Cache

The PWA should maintain a complete local cache of:

* Contacts
* Interaction history
* Tags
* Settings
* Scheduled reminders

The cache should be stored using browser technologies such as IndexedDB.

### Synchronisation Queue

When offline, any changes made by the user should be placed into a persistent synchronisation queue.

Examples of queued actions:

* Create contact
* Update contact
* Delete contact
* Add interaction
* Edit interaction
* Create tags
* Edit tags

When connectivity is restored, queued changes should automatically upload to the server in chronological order.

The user should be able to view:

* Number of pending changes
* Last successful synchronisation
* Current synchronisation status
* Any synchronisation conflicts

### Conflict Resolution

If the same record has been modified both locally and on the server, the application should:

* Detect the conflict.
* Preserve both versions where possible.
* Allow the user to choose which version to keep.
* Record conflict resolution in an audit log.

---

## Technology Preferences

### Backend

* Python 3.13+
* Flask
* SQLAlchemy ORM
* Flask-Login for authentication
* REST API returning JSON

### Frontend

* HTML5
* Jinja templates
* Bootstrap 5
* Vanilla JavaScript (preferred)
* HTMX for dynamic page updates (optional)

### Progressive Web App

The application should:

* Be installable as a PWA on Android, iOS, Windows, Linux, and macOS.
* Include a Service Worker.
* Cache static assets for offline use.
* Cache application data using IndexedDB.
* Automatically synchronise pending changes when connectivity returns.
* Support background synchronisation where supported by the browser.

### Database

Primary database:

* SQLite

Optional support:

* PostgreSQL

### Deployment

The application should support:

* Docker
* Docker Compose
* Raspberry Pi (ARM64)
* x86_64 Linux
* Tailscale remote access
* Cloudflare Tunnel remote access

### Data Ownership

The user should have complete ownership of all data.

The application should support:

* CSV export/import
* JSON export/import
* Complete SQLite database backup
* Automatic scheduled backups
* One-click database restore
