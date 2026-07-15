(function () {
  const apiBase = document.body.dataset.apiBase || "/api";
  const deviceLabel = localStorage.getItem("crm-device-label") || `Browser ${Math.random().toString(36).slice(2, 7)}`;
  localStorage.setItem("crm-device-label", deviceLabel);

  const state = {
    user: null,
    contacts: [],
    tags: [],
    settings: [],
    interactions: [],
    conflicts: [],
    queue: [],
    selectedContactId: null,
    search: "",
    tagFilterId: "",
    lastPullAt: null,
    syncing: false,
    online: navigator.onLine,
  };

  const els = {
    authPanel: document.getElementById("auth-panel"),
    workspace: document.getElementById("workspace"),
    loginForm: document.getElementById("login-form"),
    registerForm: document.getElementById("register-form"),
    loginMessage: document.getElementById("login-message"),
    registerMessage: document.getElementById("register-message"),
    connectionStatus: document.getElementById("connection-status"),
    syncStatus: document.getElementById("sync-status"),
    pendingCount: document.getElementById("pending-count"),
    contactSearch: document.getElementById("contact-search"),
    tagFilterRow: document.getElementById("tag-filter-row"),
    contactList: document.getElementById("contact-list"),
    contactForm: document.getElementById("contact-form"),
    contactTitle: document.getElementById("contact-title"),
    selectedContactStatus: document.getElementById("selected-contact-status"),
    selectedContactTags: document.getElementById("selected-contact-tags"),
    interactionList: document.getElementById("interaction-list"),
    interactionForm: document.getElementById("interaction-form"),
    saveContactButton: document.getElementById("save-contact-button"),
    deleteContactButton: document.getElementById("delete-contact-button"),
    newContactButton: document.getElementById("new-contact-button"),
    syncNowButton: document.getElementById("sync-now-button"),
    logoutButton: document.getElementById("logout-button"),
    lastSyncAt: document.getElementById("last-sync-at"),
    pendingConflicts: document.getElementById("pending-conflicts"),
    deviceLabel: document.getElementById("device-label"),
    conflictList: document.getElementById("conflict-list"),
    upcomingList: document.getElementById("upcoming-list"),
    tagForm: document.getElementById("tag-form"),
    tagList: document.getElementById("tag-list"),
    settingForm: document.getElementById("setting-form"),
    settingsList: document.getElementById("settings-list"),
    contactTemplate: document.getElementById("contact-item-template"),
    timelineTemplate: document.getElementById("timeline-template"),
    mobileDock: document.querySelector(".mobile-dock"),
  };

  function formatDate(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function toDatetimeLocal(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function fromDatetimeLocal(value) {
    if (!value) {
      return null;
    }
    return new Date(value).toISOString();
  }

  function fullName(contact) {
    return [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "Untitled contact";
  }

  function normalizeText(value) {
    return String(value || "").toLowerCase();
  }

  let dbPromise = null;
  function openDb() {
    if (dbPromise) {
      return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("crm1-pwa", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const contacts = db.createObjectStore("contacts", { keyPath: "id" });
        contacts.createIndex("client_id", "client_id", { unique: false });
        contacts.createIndex("updated_at", "updated_at", { unique: false });

        const tags = db.createObjectStore("tags", { keyPath: "id" });
        tags.createIndex("client_id", "client_id", { unique: false });

        const interactions = db.createObjectStore("interactions", { keyPath: "id" });
        interactions.createIndex("client_id", "client_id", { unique: false });
        interactions.createIndex("contact_id", "contact_id", { unique: false });

        const settings = db.createObjectStore("settings", { keyPath: "key" });
        settings.createIndex("client_id", "client_id", { unique: false });

        db.createObjectStore("conflicts", { keyPath: "id" });
        const queue = db.createObjectStore("syncQueue", { keyPath: "id", autoIncrement: true });
        queue.createIndex("client_id", "client_id", { unique: false });
        queue.createIndex("created_at", "created_at", { unique: false });

        db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function withStore(storeName, mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = callback(store, tx);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error(`Transaction aborted for ${storeName}`));
    });
  }

  async function getAll(storeName) {
    return withStore(storeName, "readonly", store => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }));
  }

  async function getByKey(storeName, key) {
    return withStore(storeName, "readonly", store => new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    }));
  }

  async function putRecord(storeName, record) {
    return withStore(storeName, "readwrite", store => new Promise((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }

  async function deleteRecord(storeName, key) {
    return withStore(storeName, "readwrite", store => new Promise((resolve, reject) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    }));
  }

  async function clearStore(storeName) {
    return withStore(storeName, "readwrite", store => new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    }));
  }

  async function getMeta(key) {
    const record = await getByKey("meta", key);
    return record ? record.value : null;
  }

  async function setMeta(key, value) {
    await putRecord("meta", { key, value });
  }

  function apiUrl(path) {
    return `${apiBase}${path}`;
  }

  async function apiFetch(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const message = payload && typeof payload === "object" && payload.error ? payload.error : `Request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function setBadge(el, text) {
    if (el) {
      el.textContent = text;
    }
  }

  function setStatus(online, syncing) {
    state.online = online;
    els.connectionStatus.innerHTML = `<span class="dot" style="background:${online ? '#4f8a10' : '#b91c1c'}"></span>${online ? 'Online' : 'Offline'}`;
    els.syncStatus.innerHTML = `<span class="dot" style="background:${syncing ? '#d97706' : '#0f7c7a'}"></span>${syncing ? 'Syncing' : 'Ready'}`;
    els.pendingCount.textContent = `${state.queue.length} pending`;
  }

  function selectedContact() {
    return state.contacts.find(contact => String(contact.id) === String(state.selectedContactId)) || null;
  }

  function populateContactForm(contact) {
    const record = contact || {
      first_name: "",
      last_name: "",
      company: "",
      job_title: "",
      email: "",
      phone: "",
      address: "",
      notes: "",
    };
    const form = els.contactForm;
    form.first_name.value = record.first_name || "";
    form.last_name.value = record.last_name || "";
    form.company.value = record.company || "";
    form.job_title.value = record.job_title || "";
    form.email.value = record.email || "";
    form.phone.value = record.phone || "";
    form.address.value = record.address || "";
    form.notes.value = record.notes || "";
    els.contactTitle.textContent = contact ? fullName(contact) : "New contact";
    els.selectedContactStatus.textContent = contact ? `Version ${contact.version || 1}` : "Draft contact";
    els.deleteContactButton.disabled = !contact;
    els.saveContactButton.textContent = contact && !String(contact.id).startsWith("local-") ? "Save" : "Create";
  }

  function contactMatches(contact) {
    const query = normalizeText(state.search);
    if (query) {
      const haystack = [contact.first_name, contact.last_name, contact.company, contact.job_title, contact.email, contact.phone, contact.notes].map(normalizeText).join(" |");
      if (!haystack.includes(query)) {
        return false;
      }
    }
    if (state.tagFilterId) {
      const tagIds = (contact.tags || []).map(tag => String(tag.id));
      if (!tagIds.includes(String(state.tagFilterId))) {
        return false;
      }
    }
    return true;
  }

  function contactSortKey(contact) {
    return new Date(contact.updated_at || contact.created_at || 0).getTime();
  }

  function renderContacts() {
    const list = state.contacts.filter(contact => !contact.is_deleted && contactMatches(contact)).sort((a, b) => contactSortKey(b) - contactSortKey(a));
    els.contactList.replaceChildren();

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "timeline-item";
      empty.innerHTML = "<strong>No contacts</strong><p>Create one or loosen the search filter.</p>";
      els.contactList.append(empty);
      return;
    }

    for (const contact of list) {
      const node = els.contactTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = contact.id;
      node.classList.toggle("active", String(contact.id) === String(state.selectedContactId));
      node.querySelector(".contact-name").textContent = fullName(contact);
      node.querySelector(".contact-meta").textContent = [contact.company, contact.email, contact.phone].filter(Boolean).join(" • ") || "No contact details yet";
      const status = node.querySelector(".mini-pill");
      status.textContent = String(contact.id).startsWith("local-") ? "Pending" : `v${contact.version || 1}`;
      node.addEventListener("click", () => selectContact(contact.id));
      els.contactList.append(node);
    }
  }

  function renderTags() {
    els.tagFilterRow.replaceChildren();

    const allTag = document.createElement("button");
    allTag.type = "button";
    allTag.className = `tag-chip${state.tagFilterId ? "" : " active"}`;
    allTag.textContent = "All";
    allTag.addEventListener("click", () => {
      state.tagFilterId = "";
      renderAll();
    });
    els.tagFilterRow.append(allTag);

    for (const tag of state.tags.filter(tag => !tag.is_deleted)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `tag-chip${String(state.tagFilterId) === String(tag.id) ? " active" : ""}`;
      chip.innerHTML = `<span class="chip" style="background:${tag.color || '#6c757d'}"></span><span>${tag.name}</span>`;
      chip.addEventListener("click", () => {
        state.tagFilterId = String(tag.id);
        renderAll();
      });
      els.tagFilterRow.append(chip);
    }

    els.tagList.replaceChildren();
    for (const tag of state.tags.filter(tag => !tag.is_deleted).sort((a, b) => a.name.localeCompare(b.name))) {
      const row = document.createElement("div");
      row.className = "tag-row";
      row.innerHTML = `<span style="display:flex;align-items:center;gap:0.6rem"><span class="chip" style="background:${tag.color || '#6c757d'}"></span><strong>${tag.name}</strong></span>`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => queueDeleteTag(tag));
      row.append(remove);
      els.tagList.append(row);
    }
  }

  function renderSelectedContactTags(contact) {
    els.selectedContactTags.replaceChildren();
    if (!contact) {
      els.selectedContactTags.innerHTML = '<span class="muted">Select a saved contact to attach tags.</span>';
      return;
    }

    const currentTags = contact.tags || [];
    if (!currentTags.length) {
      els.selectedContactTags.innerHTML = '<span class="muted">No tags yet.</span>';
    }

    for (const tag of currentTags) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.innerHTML = `<span class="chip" style="background:${tag.color || '#6c757d'}"></span><span>${tag.name}</span>`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "×";
      button.title = "Remove tag";
      button.addEventListener("click", () => queueToggleContactTag(contact, tag, false));
      chip.append(button);
      els.selectedContactTags.append(chip);
    }

    const available = state.tags.filter(tag => !currentTags.some(current => String(current.id) === String(tag.id)) && !tag.is_deleted);
    for (const tag of available) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tag-chip";
      button.innerHTML = `<span class="chip" style="background:${tag.color || '#6c757d'}"></span><span>+ ${tag.name}</span>`;
      button.addEventListener("click", () => queueToggleContactTag(contact, tag, true));
      els.selectedContactTags.append(button);
    }
  }

  function interactionSummary(item) {
    return [item.subject, item.body].filter(Boolean).join(" - ") || "No details";
  }

  function renderInteractions(contact) {
    els.interactionList.replaceChildren();
    if (!contact) {
      els.interactionList.innerHTML = '<article class="timeline-item"><strong>Select a contact</strong><p>Interaction history appears here.</p></article>';
      return;
    }

    const items = state.interactions
      .filter(item => !item.is_deleted && String(item.contact_id) === String(contact.id))
      .sort((a, b) => new Date((b.occurred_at || b.scheduled_at || b.created_at || 0)).getTime() - new Date((a.occurred_at || a.scheduled_at || a.created_at || 0)).getTime());

    if (!items.length) {
      els.interactionList.innerHTML = '<article class="timeline-item"><strong>No interactions</strong><p>Log the first note, call, or follow-up.</p></article>';
      return;
    }

    for (const item of items) {
      const node = els.timelineTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector("strong").textContent = item.subject || item.type || "Interaction";
      node.querySelector("span").textContent = formatDate(item.occurred_at || item.scheduled_at || item.created_at);
      node.querySelector("p").textContent = interactionSummary(item);
      els.interactionList.append(node);
    }
  }

  function renderUpcoming() {
    const now = Date.now();
    const items = state.interactions
      .filter(item => !item.is_deleted && item.scheduled_at && !item.is_completed)
      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
      .slice(0, 8);

    els.upcomingList.replaceChildren();
    if (!items.length) {
      els.upcomingList.innerHTML = '<article class="timeline-item"><strong>No upcoming reminders</strong><p>Schedule a follow-up to see it here.</p></article>';
      return;
    }

    for (const item of items) {
      const node = els.timelineTemplate.content.firstElementChild.cloneNode(true);
      const due = new Date(item.scheduled_at).getTime();
      const deltaHours = Math.round((due - now) / 3600000);
      node.querySelector("strong").textContent = item.subject || item.type || "Reminder";
      node.querySelector("span").textContent = deltaHours <= 24 ? `${Math.max(1, deltaHours)}h away` : formatDate(item.scheduled_at);
      node.querySelector("p").textContent = item.body || "Scheduled follow-up";
      els.upcomingList.append(node);
    }
  }

  function renderSettings() {
    els.settingsList.replaceChildren();
    if (!state.settings.length) {
      els.settingsList.innerHTML = '<article><div><strong>No settings saved</strong><small>Store browser-specific preferences here.</small></div></article>';
      return;
    }

    for (const setting of state.settings.sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
      const article = document.createElement("article");
      article.innerHTML = `<div><strong>${setting.key}</strong><small>${setting.value ?? ""}</small></div>`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => queueDeleteSetting(setting));
      article.append(remove);
      els.settingsList.append(article);
    }
  }

  function renderConflicts() {
    els.conflictList.replaceChildren();
    if (!state.conflicts.length) {
      els.conflictList.innerHTML = '<article class="timeline-item"><strong>No conflicts</strong><p>Resolved sync issues will appear here.</p></article>';
      return;
    }

    for (const conflict of state.conflicts.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())) {
      const node = els.timelineTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector("strong").textContent = `${conflict.entity_type} #${conflict.entity_id}`;
      node.querySelector("span").textContent = conflict.status;
      node.querySelector("p").textContent = `Client version ${conflict.client_base_version} vs server version ${conflict.server_version}`;

      const actions = document.createElement("div");
      actions.className = "header-actions compact";
      const keepServer = document.createElement("button");
      keepServer.type = "button";
      keepServer.className = "ghost-button small";
      keepServer.textContent = "Keep server";
      keepServer.addEventListener("click", () => resolveConflict(conflict.id, "keep_server"));
      const keepClient = document.createElement("button");
      keepClient.type = "button";
      keepClient.className = "primary-button small";
      keepClient.textContent = "Keep client";
      keepClient.addEventListener("click", () => resolveConflict(conflict.id, "keep_client"));
      actions.append(keepServer, keepClient);
      node.append(actions);
      els.conflictList.append(node);
    }
  }

  function renderHeaderState() {
    setStatus(state.online, state.syncing);
    els.pendingConflicts.textContent = String(state.conflicts.filter(conflict => conflict.status === "pending").length);
    els.lastSyncAt.textContent = state.lastPullAt ? formatDate(state.lastPullAt) : "Never";
    els.deviceLabel.textContent = deviceLabel;
  }

  function renderAll() {
    const contact = selectedContact();
    renderHeaderState();
    renderTags();
    renderContacts();
    renderSelectedContactTags(contact);
    renderInteractions(contact);
    renderUpcoming();
    renderSettings();
    renderConflicts();
    if (!contact) {
      populateContactForm(null);
    }
  }

  function setAppVisible(visible) {
    els.authPanel.classList.toggle("hidden", visible);
    els.workspace.classList.toggle("hidden", !visible);
    if (els.mobileDock) {
      els.mobileDock.classList.toggle("hidden", !visible);
    }
  }

  function scrollToTarget(selector) {
    const target = document.querySelector(selector);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function replaceTempRecord(storeName, clientId, serverRecord) {
    if (!clientId) {
      return;
    }
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const index = store.index("client_id");
      const request = index.get(clientId);
      request.onsuccess = () => {
        const existing = request.result;
        if (existing && String(existing.id) !== String(serverRecord.id)) {
          store.delete(existing.id);
        }
        store.put(serverRecord);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadLocalState() {
    state.contacts = await getAll("contacts");
    state.tags = await getAll("tags");
    state.settings = await getAll("settings");
    state.interactions = await getAll("interactions");
    state.queue = await getAll("syncQueue");
    state.conflicts = await getAll("conflicts");
    state.lastPullAt = await getMeta("lastPullAt");
    const selection = await getMeta("selectedContactId");
    state.selectedContactId = selection || state.contacts[0]?.id || null;
    const selected = selectedContact();
    if (selected) {
      populateContactForm(selected);
    } else {
      populateContactForm(null);
    }
    renderAll();
  }

  async function loadRemoteSnapshot() {
    if (!state.user || !navigator.onLine) {
      return;
    }

    const query = state.lastPullAt ? `?since=${encodeURIComponent(state.lastPullAt)}` : "";
    const result = await apiFetch(`/sync/pull${query}`);
    const data = result.data || {};

    for (const contact of data.contacts || []) {
      await replaceTempRecord("contacts", contact.client_id, contact);
      await putRecord("contacts", contact);
    }
    for (const interaction of data.interactions || []) {
      await replaceTempRecord("interactions", interaction.client_id, interaction);
      await putRecord("interactions", interaction);
    }
    for (const tag of data.tags || []) {
      await replaceTempRecord("tags", tag.client_id, tag);
      await putRecord("tags", tag);
    }
    for (const setting of data.settings || []) {
      await putRecord("settings", setting);
    }

    state.lastPullAt = result.server_time || new Date().toISOString();
    await setMeta("lastPullAt", state.lastPullAt);
    await loadLocalState();
  }

  async function pushQueue() {
    if (!state.queue.length || !state.user || !navigator.onLine) {
      return;
    }

    state.syncing = true;
    renderHeaderState();

    try {
      const queueItems = [...state.queue].sort((a, b) => a.id - b.id);
      for (const item of queueItems) {
        if (item.transport === "api") {
          await apiFetch(item.path, {
            method: item.method || "POST",
            body: item.body ? JSON.stringify(item.body) : undefined,
          });
          await deleteRecord("syncQueue", item.id);
          continue;
        }

        const result = await apiFetch("/sync", {
          method: "POST",
          body: JSON.stringify({
            device_label: deviceLabel,
            changes: [{
              op: item.op,
              entity_type: item.entity_type,
              payload: item.payload,
              client_id: item.client_id || undefined,
              entity_id: item.entity_id !== undefined && item.entity_id !== null ? item.entity_id : undefined,
              base_version: item.base_version !== undefined && item.base_version !== null ? item.base_version : undefined,
            }],
          }),
        });

        if (result.results && result.results[0] && result.results[0].status === "applied" && result.results[0].server) {
          const serverRecord = result.results[0].server;
          if (item.op === "create" && item.entity_type === "contact") {
            await replaceTempRecord("contacts", item.client_id, serverRecord);
          }
          if (item.op === "create" && item.entity_type === "interaction") {
            await replaceTempRecord("interactions", item.client_id, serverRecord);
          }
          if (item.op === "create" && item.entity_type === "tag") {
            await replaceTempRecord("tags", item.client_id, serverRecord);
          }
          if (item.op === "create" && item.entity_type === "setting") {
            await replaceTempRecord("settings", item.client_id, serverRecord);
          }
          if (item.op === "update" && item.entity_type === "contact") {
            await putRecord("contacts", serverRecord);
          }
          if (item.op === "delete" && item.entity_type === "contact") {
            await deleteRecord("contacts", item.entity_id);
          }
        }

        await deleteRecord("syncQueue", item.id);
      }

      state.queue = [];
      await setMeta("lastSyncedAt", new Date().toISOString());
      await loadRemoteSnapshot();
      await refreshSyncInfo();
    } catch (error) {
      setBadge(els.syncStatus, error.status === 401 ? "Sign in required" : error.message);
      if (error.status === 401) {
        await handleSessionLoss();
      }
    } finally {
      state.syncing = false;
      renderHeaderState();
    }
  }

  async function refreshSyncInfo() {
    if (!state.user || !navigator.onLine) {
      renderHeaderState();
      return;
    }
    try {
      const status = await apiFetch("/sync/status");
      els.lastSyncAt.textContent = status.last_synced_at ? formatDate(status.last_synced_at) : "Never";
      els.pendingConflicts.textContent = String(status.pending_conflicts || 0);
      const conflicts = await apiFetch("/sync/conflicts");
      state.conflicts = conflicts.conflicts || [];
      await clearStore("conflicts");
      await putMany("conflicts", state.conflicts);
      renderConflicts();
    } catch (error) {
      if (error.status === 401) {
        await handleSessionLoss();
      }
    }
  }

  async function putMany(storeName, records) {
    for (const record of records) {
      await putRecord(storeName, record);
    }
  }

  async function syncAll() {
    if (!state.user) {
      return;
    }
    await loadLocalState();
    if (navigator.onLine) {
      await pushQueue();
      await loadRemoteSnapshot();
      await refreshSyncInfo();
    }
    renderAll();
  }

  async function enqueueChange(item) {
    await putRecord("syncQueue", {
      ...item,
      created_at: new Date().toISOString(),
    });
    state.queue = await getAll("syncQueue");
    renderHeaderState();
    if (navigator.onLine) {
      await syncAll();
    }
  }

  async function saveContactFromForm() {
    const selected = selectedContact();
    const data = readContactForm();
    if (!data.first_name) {
      throw new Error("First name is required");
    }

    if (!selected || String(selected.id).startsWith("local-")) {
      const clientId = selected?.client_id || crypto.randomUUID();
      const record = {
        id: selected?.id || `local-${clientId}`,
        client_id: clientId,
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_deleted: false,
        ...data,
      };
      await putRecord("contacts", record);
      state.selectedContactId = record.id;
      await setMeta("selectedContactId", state.selectedContactId);
      const existing = await findQueueCreateByClientId(record.client_id, "contact");
      if (existing) {
        existing.payload = data;
        await putRecord("syncQueue", existing);
      } else {
        await enqueueChange({
          op: "create",
          entity_type: "contact",
          client_id: record.client_id,
          payload: data,
        });
      }
      return;
    }

    const updated = {
      ...selected,
      ...data,
      version: (selected.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    await putRecord("contacts", updated);
    await enqueueChange({
      op: "update",
      entity_type: "contact",
      entity_id: selected.id,
      base_version: selected.version || 1,
      payload: data,
    });
  }

  async function findQueueCreateByClientId(clientId, entityType) {
    const queue = await getAll("syncQueue");
    return queue.find(item => item.op === "create" && item.entity_type === entityType && item.client_id === clientId) || null;
  }

  async function queueDeleteContact(contact) {
    if (!contact) {
      return;
    }
    if (!confirm(`Delete ${fullName(contact)}?`)) {
      return;
    }
    if (String(contact.id).startsWith("local-")) {
      await deleteRecord("contacts", contact.id);
      state.contacts = await getAll("contacts");
      state.selectedContactId = state.contacts[0]?.id || null;
      await setMeta("selectedContactId", state.selectedContactId);
      renderAll();
      return;
    }
    await enqueueChange({
      op: "delete",
      entity_type: "contact",
      entity_id: contact.id,
      base_version: contact.version || 1,
      payload: {},
    });
    await deleteRecord("contacts", contact.id);
    state.selectedContactId = state.contacts.find(item => String(item.id) !== String(contact.id))?.id || null;
    await setMeta("selectedContactId", state.selectedContactId);
  }

  async function queueToggleContactTag(contact, tag, add) {
    if (!contact || String(contact.id).startsWith("local-")) {
      alert("Save the contact before attaching tags.");
      return;
    }
    const updated = { ...contact, tags: [...(contact.tags || [])] };
    if (add) {
      if (!updated.tags.some(current => String(current.id) === String(tag.id))) {
        updated.tags.push(tag);
      }
    } else {
      updated.tags = updated.tags.filter(current => String(current.id) !== String(tag.id));
    }
    await putRecord("contacts", updated);
    state.contacts = await getAll("contacts");
    renderAll();

    await enqueueChange({
      transport: "api",
      method: add ? "POST" : "DELETE",
      path: `/contacts/${contact.id}/tags/${tag.id}`,
      body: null,
    });
  }

  async function queueDeleteTag(tag) {
    if (!confirm(`Delete tag ${tag.name}?`)) {
      return;
    }
    await enqueueChange({
      op: "delete",
      entity_type: "tag",
      entity_id: tag.id,
      base_version: tag.version || 1,
      payload: {},
    });
    await deleteRecord("tags", tag.id);
    state.tags = await getAll("tags");
    renderAll();
  }

  async function queueDeleteSetting(setting) {
    if (!confirm(`Delete setting ${setting.key}?`)) {
      return;
    }
    await deleteRecord("settings", setting.key);
    state.settings = await getAll("settings");
    renderAll();
    await enqueueChange({
      transport: "api",
      method: "DELETE",
      path: `/settings/${encodeURIComponent(setting.key)}`,
      body: null,
    });
  }

  function readInteractionForm() {
    const form = els.interactionForm;
    return {
      type: form.type.value,
      subject: form.subject.value.trim() || null,
      body: form.body.value.trim() || null,
      occurred_at: fromDatetimeLocal(form.occurred_at.value),
      scheduled_at: fromDatetimeLocal(form.scheduled_at.value),
      is_completed: form.is_completed.checked,
    };
  }

  async function saveInteractionFromForm() {
    const contact = selectedContact();
    if (!contact || String(contact.id).startsWith("local-")) {
      throw new Error("Choose a saved contact before adding an interaction");
    }
    const payload = readInteractionForm();
    const clientId = crypto.randomUUID();
    const record = {
      id: `local-${clientId}`,
      client_id: clientId,
      contact_id: contact.id,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_deleted: false,
      ...payload,
    };
    await putRecord("interactions", record);
    state.interactions = await getAll("interactions");
    await enqueueChange({
      op: "create",
      entity_type: "interaction",
      client_id: clientId,
      payload: {
        contact_id: contact.id,
        ...payload,
      },
    });
  }

  async function saveTagFromForm(event) {
    event.preventDefault();
    const form = els.tagForm;
    const name = form.name.value.trim();
    const color = form.color.value || "#6c757d";
    if (!name) {
      return;
    }
    await enqueueChange({
      op: "create",
      entity_type: "tag",
      client_id: crypto.randomUUID(),
      payload: { name, color },
    });
    form.reset();
    form.color.value = color;
    await syncAll();
  }

  async function saveSettingFromForm(event) {
    event.preventDefault();
    const form = els.settingForm;
    const key = form.key.value.trim();
    const value = form.value.value.trim();
    if (!key) {
      return;
    }
    await putRecord("settings", {
      key,
      value,
      client_id: crypto.randomUUID(),
      version: 1,
      updated_at: new Date().toISOString(),
    });
    state.settings = await getAll("settings");
    form.reset();
    renderAll();
    await enqueueChange({
      transport: "api",
      method: "PUT",
      path: `/settings/${encodeURIComponent(key)}`,
      body: { value },
    });
  }

  async function resolveConflict(conflictId, resolution) {
    try {
      await apiFetch(`/sync/conflicts/${conflictId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution }),
      });
      await deleteRecord("conflicts", conflictId);
      await syncAll();
    } catch (error) {
      alert(error.message);
    }
  }

  function selectContact(id) {
    state.selectedContactId = id;
    setMeta("selectedContactId", id);
    const contact = selectedContact();
    populateContactForm(contact);
    renderAll();
  }

  async function createNewContact() {
    state.selectedContactId = `local-${crypto.randomUUID()}`;
    await setMeta("selectedContactId", state.selectedContactId);
    els.contactForm.reset();
    populateContactForm(null);
    renderAll();
    scrollToTarget("#editor-panel");
  }

  async function handleSessionLoss() {
    state.user = null;
    state.contacts = [];
    state.tags = [];
    state.settings = [];
    state.interactions = [];
    state.conflicts = [];
    state.queue = [];
    setAppVisible(false);
  }

  async function loadCurrentUser() {
    try {
      const payload = await apiFetch("/auth/me");
      state.user = payload.user;
      setAppVisible(true);
      await loadLocalState();
      await syncAll();
      els.deviceLabel.textContent = deviceLabel;
    } catch {
      state.user = null;
      setAppVisible(false);
    }
  }

  async function submitAuth(endpoint, form, messageEl) {
    messageEl.textContent = "";
    const body = Object.fromEntries(new FormData(form).entries());
    body.remember = Boolean(body.remember);
    try {
      const payload = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      state.user = payload.user;
      setAppVisible(true);
      await syncAll();
    } catch (error) {
      messageEl.textContent = error.message;
    }
  }

  function bindEvents() {
    els.contactSearch.addEventListener("input", event => {
      state.search = event.target.value;
      renderContacts();
    });

    els.newContactButton.addEventListener("click", () => {
      createNewContact();
    });

    els.saveContactButton.addEventListener("click", async () => {
      try {
        await saveContactFromForm();
        await syncAll();
      } catch (error) {
        alert(error.message);
      }
    });

    els.deleteContactButton.addEventListener("click", async () => {
      try {
        await queueDeleteContact(selectedContact());
        await syncAll();
      } catch (error) {
        alert(error.message);
      }
    });

    els.interactionForm.addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await saveInteractionFromForm();
        event.target.reset();
        await syncAll();
      } catch (error) {
        alert(error.message);
      }
    });

    els.syncNowButton.addEventListener("click", async () => {
      await syncAll();
    });

    els.logoutButton.addEventListener("click", async () => {
      try {
        await apiFetch("/auth/logout", { method: "POST" });
      } catch {
        // ignore session expiry
      }
      await handleSessionLoss();
    });

    els.loginForm.addEventListener("submit", event => {
      event.preventDefault();
      submitAuth("/auth/login", event.currentTarget, els.loginMessage);
    });

    els.registerForm.addEventListener("submit", event => {
      event.preventDefault();
      submitAuth("/auth/register", event.currentTarget, els.registerMessage);
    });

    els.tagForm.addEventListener("submit", saveTagFromForm);
    els.settingForm.addEventListener("submit", saveSettingFromForm);

    if (els.mobileDock) {
      els.mobileDock.addEventListener("click", event => {
        const button = event.target.closest("button[data-jump]");
        if (!button) {
          return;
        }
        scrollToTarget(button.dataset.jump);
      });
    }

    window.addEventListener("online", async () => {
      state.online = true;
      renderHeaderState();
      await syncAll();
    });
    window.addEventListener("offline", () => {
      state.online = false;
      renderHeaderState();
    });
  }

  async function bootstrap() {
    bindEvents();
    await openDb();
    els.deviceLabel.textContent = deviceLabel;
    renderHeaderState();

    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("/sw.js");
      } catch {
        // service worker is progressive enhancement
      }
    }

    await loadCurrentUser();
    if (state.user) {
      await syncAll();
    }
    setStatus(navigator.onLine, false);
  }

  bootstrap().catch(error => {
    console.error(error);
    setBadge(els.syncStatus, error.message);
  });
})();