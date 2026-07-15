def register_blueprints(app):
    from app.api import auth, contacts, interactions, tags, settings, sync, data, audit

    app.register_blueprint(auth.bp)
    app.register_blueprint(contacts.bp)
    app.register_blueprint(interactions.bp)
    app.register_blueprint(tags.bp)
    app.register_blueprint(settings.bp)
    app.register_blueprint(sync.bp)
    app.register_blueprint(data.bp)
    app.register_blueprint(audit.bp)
