(function () {
  const apiBase = document.body.dataset.apiBase || "/api";
  const deviceLabel = localStorage.getItem("crm-device-label") || `Browser ${Math.random().toString(36).slice(2, 7)}`;
  localStorage.setItem("crm-device-label", deviceLabel);

  // crypto.randomUUID() only exists in secure contexts (HTTPS or localhost).
  // On a phone hitting the app over plain HTTP via a LAN IP, it's simply
  // not there. Fall back to crypto.getRandomValues (which IS available in
  // insecure contexts), and to Math.random as a last resort so contact/tag/
  // interaction creation never breaks regardless of how the app is served.
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const bytes = window.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
      const rand = (Math.random() * 16) | 0;
      const value = char === "x" ? rand : (rand & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  const STORE_BY_ENTITY = { contact: "contacts", interaction: "interactions", tag: "tags", setting: "settings" };

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
    editingInteractionId: null,
    editingTagId: null,
  };

  const els = {
    authPanel: document.getElementById("auth-panel"),
    workspace: document.getElementById("workspace"),
    loginForm: document.getElementById("login-form"),
    registerForm: document.getElementById("register-form"),
    loginMessage: document.getElementById("login-message"),
    registerMessage: document.getElementById("register-message"),
    syncStatusValue: document.getElementById("sync-status-value"),
    pendingCountValue: document.getElementById("pending-count-value"),
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
    backToContactsButton: document.getElementById("back-to-contacts-button"),
    sheetOverlay: document.getElementById("sheet-overlay"),
    sheetTitle: document.getElementById("sheet-title"),
    addInteractionButton: document.getElementById("add-interaction-button"),
    saveInteractionButton: document.getElementById("save-interaction-button"),
    tagEditForm: document.getElementById("tag-edit-form"),
    offlineBanner: document.getElementById("offline-banner"),
    syncBadge: document.getElementById("sync-badge"),
    emptyDetail: document.getElementById("empty-detail"),
    detailBody: document.getElementById("detail-body"),
    editorActions: document.getElementById("editor-actions"),
    detailTitleRow: document.getElementById("detail-title-row"),
    queueList: document.getElementById("queue-list"),
    csvImportForm: document.getElementById("csv-import-form"),
    csvImportMessage: document.getElementById("csv-import-message"),
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

    if (els.syncStatusValue) {
      els.syncStatusValue.textContent = !online ? "Offline" : syncing ? "Syncing…" : "Ready";
    }
    if (els.pendingCountValue) {
      els.pendingCountValue.textContent = String(state.queue.length);
    }

    if (els.syncBadge) {
      const pending = state.queue.length;
      els.syncBadge.textContent = pending > 9 ? "9+" : String(pending);
      els.syncBadge.classList.toggle("hidden", pending === 0 || syncing);
      els.syncNowButton.classList.toggle("is-syncing", syncing);
    }

    if (els.offlineBanner) {
      if (!online) {
        els.offlineBanner.textContent = "Offline — changes are saved and will sync automatically";
        els.offlineBanner.classList.remove("hidden");
      } else {
        els.offlineBanner.classList.add("hidden");
      }
    }

    renderQueue();
  }

  function readContactForm() {
    const form = els.contactForm;
    return {
      first_name: form.first_name.value.trim(),
      last_name: form.last_name.value.trim() || null,
      company: form.company.value.trim() || null,
      job_title: form.job_title.value.trim() || null,
      email: form.email.value.trim() || null,
      phone: form.phone.value.trim() || null,
      address: form.address.value.trim() || null,
      notes: form.notes.value.trim() || null,
    };
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
      const name = fullName(contact);
      const initials = name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0].toUpperCase())
        .join("") || "?";
      const avatar = node.querySelector(".contact-avatar");
      if (avatar) {
        avatar.textContent = initials;
      }
      node.querySelector(".contact-name").textContent = name;
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
      const actions = document.createElement("div");
      actions.className = "tag-row-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "text-button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openTagSheet(tag));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => queueDeleteTag(tag));
      actions.append(edit, remove);
      row.append(actions);
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
      if (item.is_completed) {
        node.classList.add("is-complete");
      }
      node.classList.add("tappable");
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.addEventListener("click", () => openInteractionSheet(item));
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
      node.classList.add("tappable");
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.addEventListener("click", () => openInteractionSheet(item));
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

  function describeQueueItem(item) {
    const verb = { create: "Create", update: "Update", delete: "Delete" }[item.op] || item.op;
    const noun = { contact: "contact", interaction: "interaction", tag: "tag", setting: "setting", contact_tag: "tag link" }[item.entity_type] || item.entity_type;
    const payload = item.payload || {};
    let label = "";
    if (item.entity_type === "contact") {
      label = [payload.first_name, payload.last_name].filter(Boolean).join(" ");
    } else if (item.entity_type === "interaction") {
      label = payload.subject || payload.type || "";
    } else if (item.entity_type === "tag") {
      label = payload.name || "";
    } else if (item.entity_type === "setting") {
      label = payload.key || "";
    }
    return { title: `${verb} ${noun}`, detail: label || "—" };
  }

  function renderQueue() {
    if (!els.queueList) {
      return;
    }
    els.queueList.replaceChildren();
    if (!state.queue.length) {
      els.queueList.innerHTML = '<article class="timeline-item"><strong>Nothing pending</strong><p>Everything is synced.</p></article>';
      return;
    }
    for (const item of state.queue.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
      const { title, detail } = describeQueueItem(item);
      const node = els.timelineTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector("strong").textContent = title;
      node.querySelector("span").textContent = formatDate(item.created_at);
      node.querySelector("p").textContent = detail;
      els.queueList.append(node);
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
    const hasSelection = state.selectedContactId != null;
    renderHeaderState();
    renderTags();
    renderContacts();
    renderSelectedContactTags(contact);
    renderInteractions(contact);
    renderUpcoming();
    renderSettings();
    renderConflicts();
    renderQueue();
    if (els.emptyDetail && els.detailBody) {
      els.emptyDetail.classList.toggle("hidden", hasSelection);
      els.detailBody.classList.toggle("hidden", !hasSelection);
    }
    if (els.detailTitleRow) {
      els.detailTitleRow.classList.toggle("hidden", !hasSelection);
    }
    if (els.editorActions) {
      els.editorActions.classList.toggle("hidden", !contact);
    }
  }

  function setAppVisible(visible) {
    els.authPanel.classList.toggle("hidden", visible);
    els.workspace.classList.toggle("hidden", !visible);
    if (els.mobileDock) {
      els.mobileDock.classList.toggle("hidden", !visible);
    }
    if (visible) {
      const isDesktop = window.matchMedia("(min-width: 900px)").matches;
      showScreen(isDesktop ? "editor-panel" : "contacts-panel");
    }
  }

  function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach(screen => {
      screen.classList.toggle("screen-active", screen.id === screenId);
    });
    document.querySelectorAll(".mobile-dock button[data-screen]").forEach(button => {
      button.classList.toggle("active", button.dataset.screen === screenId);
    });
    const scrollTarget = document.querySelector(`#${screenId}`) || document.querySelector("main.layout");
    if (scrollTarget && window.matchMedia("(max-width: 899px)").matches) {
      window.scrollTo({ top: 0, behavior: "auto" });
    } else if (scrollTarget) {
      scrollTarget.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function replaceTempRecord(storeName, clientId, serverRecord) {
    if (!clientId) {
      return null;
    }
    const db = await openDb();
    let oldId = null;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const index = store.index("client_id");
      const request = index.get(clientId);
      request.onsuccess = () => {
        const existing = request.result;
        if (existing && String(existing.id) !== String(serverRecord.id)) {
          oldId = existing.id;
          store.delete(existing.id);
        }
        store.put(serverRecord);
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    return oldId;
  }

  async function reassignContactReferences(oldContactId, newContactId) {
    const interactions = await getAll("interactions");
    for (const interaction of interactions) {
      if (String(interaction.contact_id) === String(oldContactId)) {
        await putRecord("interactions", { ...interaction, contact_id: newContactId });
      }
    }
    state.interactions = await getAll("interactions");
    if (String(state.selectedContactId) === String(oldContactId)) {
      state.selectedContactId = newContactId;
      await setMeta("selectedContactId", newContactId);
    }
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
          const store = STORE_BY_ENTITY[item.entity_type];
          if (store) {
            if (item.op === "create") {
              const oldId = await replaceTempRecord(store, item.client_id, serverRecord);
              if (item.entity_type === "contact" && oldId && String(oldId) !== String(serverRecord.id)) {
                await reassignContactReferences(oldId, serverRecord.id);
              }
            } else if (item.op === "update") {
              await putRecord(store, serverRecord);
            } else if (item.op === "delete") {
              await deleteRecord(store, item.entity_id);
            }
          } else if (item.entity_type === "contact_tag") {
            await putRecord("contacts", serverRecord);
            state.contacts = await getAll("contacts");
          }
        }

        await deleteRecord("syncQueue", item.id);
      }

      state.queue = [];
      await setMeta("lastSyncedAt", new Date().toISOString());
      await loadRemoteSnapshot();
      await refreshSyncInfo();
    } catch (error) {
      setBadge(els.syncStatusValue, error.status === 401 ? "Sign in required" : error.message);
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

  async function requestBackgroundSync() {
    if (!("serviceWorker" in navigator) || !("SyncManager" in window)) {
      return; // not supported in this browser - falls back to the 'online' event
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.sync.register("crm-sync-queue");
    } catch {
      // background sync is a progressive enhancement, safe to ignore
    }
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
    } else {
      await requestBackgroundSync();
    }
  }

  async function saveContactFromForm() {
    const selected = selectedContact();
    const data = readContactForm();
    if (!data.first_name) {
      throw new Error("First name is required");
    }

    if (!selected || String(selected.id).startsWith("local-")) {
      const clientId = selected?.client_id || uuid();
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
    if (!contact || !tag) {
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
      op: add ? "create" : "delete",
      entity_type: "contact_tag",
      client_id: uuid(),
      payload: {
        contact_client_id: contact.client_id,
        tag_client_id: tag.client_id,
      },
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

  function populateInteractionForm(item) {
    const form = els.interactionForm;
    form.reset();
    if (!item) {
      return;
    }
    form.type.value = item.type || "note";
    form.subject.value = item.subject || "";
    form.body.value = item.body || "";
    form.occurred_at.value = toDatetimeLocal(item.occurred_at);
    form.scheduled_at.value = toDatetimeLocal(item.scheduled_at);
    form.is_completed.checked = Boolean(item.is_completed);
  }

  function openInteractionSheet(item) {
    state.editingInteractionId = item ? item.id : null;
    els.sheetTitle.textContent = item ? "Edit interaction" : "New interaction";
    els.saveInteractionButton.textContent = item ? "Save changes" : "Add interaction";
    populateInteractionForm(item);
    openSheet("interaction-sheet");
  }

  async function saveInteractionFromForm() {
    const payload = readInteractionForm();

    if (state.editingInteractionId) {
      const existing = state.interactions.find(item => String(item.id) === String(state.editingInteractionId));
      if (!existing) {
        throw new Error("That interaction is no longer available");
      }
      const updated = {
        ...existing,
        ...payload,
        version: (existing.version || 1) + 1,
        updated_at: new Date().toISOString(),
      };
      await putRecord("interactions", updated);
      state.interactions = await getAll("interactions");
      if (!String(existing.id).startsWith("local-")) {
        await enqueueChange({
          op: "update",
          entity_type: "interaction",
          entity_id: existing.id,
          base_version: existing.version || 1,
          payload,
        });
      }
      return;
    }

    const contact = selectedContact();
    if (!contact) {
      throw new Error("Choose a contact before adding an interaction");
    }
    const clientId = uuid();
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
        contact_client_id: contact.client_id,
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
    const clientId = uuid();
    const record = {
      id: `local-${clientId}`,
      client_id: clientId,
      name,
      color,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_deleted: false,
    };
    await putRecord("tags", record);
    state.tags = await getAll("tags");
    renderAll();
    await enqueueChange({
      op: "create",
      entity_type: "tag",
      client_id: clientId,
      payload: { name, color },
    });
    form.reset();
    form.color.value = color;
  }

  function openTagSheet(tag) {
    state.editingTagId = tag.id;
    els.tagEditForm.name.value = tag.name || "";
    els.tagEditForm.color.value = tag.color || "#6c757d";
    openSheet("tag-edit-sheet");
  }

  async function saveTagEditFromForm(event) {
    event.preventDefault();
    const existing = state.tags.find(tag => String(tag.id) === String(state.editingTagId));
    if (!existing) {
      return;
    }
    const name = els.tagEditForm.name.value.trim();
    const color = els.tagEditForm.color.value || "#6c757d";
    if (!name) {
      return;
    }
    const payload = { name, color };
    const updated = { ...existing, ...payload, version: (existing.version || 1) + 1, updated_at: new Date().toISOString() };
    await putRecord("tags", updated);
    state.tags = await getAll("tags");
    renderAll();
    closeSheet();
    await enqueueChange({
      op: "update",
      entity_type: "tag",
      entity_id: existing.id,
      base_version: existing.version || 1,
      payload,
    });
  }

  function openSheet(sheetId) {
    document.querySelectorAll(".sheet").forEach(sheet => sheet.classList.toggle("sheet-active", sheet.id === sheetId));
    els.sheetOverlay.classList.remove("hidden");
    requestAnimationFrame(() => els.sheetOverlay.classList.add("open"));
  }

  function closeSheet() {
    els.sheetOverlay.classList.remove("open");
    state.editingInteractionId = null;
    state.editingTagId = null;
    setTimeout(() => els.sheetOverlay.classList.add("hidden"), 180);
  }

  async function handleCsvImport(event) {
    event.preventDefault();
    const form = els.csvImportForm;
    const fileInput = form.querySelector('input[type="file"]');
    const file = fileInput.files[0];
    const messageEl = els.csvImportMessage;

    if (!file) {
      return;
    }
    if (!navigator.onLine) {
      if (messageEl) {
        messageEl.textContent = "Connect to the internet to import a CSV file.";
      }
      return;
    }

    if (messageEl) {
      messageEl.textContent = "Importing…";
    }

    try {
      const body = new FormData();
      body.append("file", file);
      // Raw fetch, not apiFetch: file uploads need a multipart boundary the
      // browser sets itself, so no Content-Type header can be forced here.
      const response = await fetch(apiUrl("/data/import/csv"), {
        method: "POST",
        credentials: "same-origin",
        body,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((payload && payload.error) || `Import failed (${response.status})`);
      }
      if (messageEl) {
        messageEl.textContent = `Imported ${payload.created} contact${payload.created === 1 ? "" : "s"}${payload.skipped ? `, skipped ${payload.skipped}` : ""}.`;
      }
      form.reset();
      await syncAll();
    } catch (error) {
      if (messageEl) {
        messageEl.textContent = error.message;
      }
    }
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
      client_id: uuid(),
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
    showScreen("editor-panel");
  }

  async function createNewContact() {
    state.selectedContactId = `local-${uuid()}`;
    await setMeta("selectedContactId", state.selectedContactId);
    els.contactForm.reset();
    populateContactForm(null);
    renderAll();
    showScreen("editor-panel");
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
        showScreen("contacts-panel");
      } catch (error) {
        alert(error.message);
      }
    });

    els.interactionForm.addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await saveInteractionFromForm();
        event.target.reset();
        closeSheet();
        await syncAll();
      } catch (error) {
        alert(error.message);
      }
    });

    if (els.addInteractionButton) {
      els.addInteractionButton.addEventListener("click", () => openInteractionSheet(null));
    }

    if (els.tagEditForm) {
      els.tagEditForm.addEventListener("submit", saveTagEditFromForm);
    }

    if (els.sheetOverlay) {
      els.sheetOverlay.addEventListener("click", event => {
        if (event.target === els.sheetOverlay || event.target.closest("[data-sheet-close]")) {
          closeSheet();
        }
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && els.sheetOverlay.classList.contains("open")) {
          closeSheet();
        }
      });
    }

    els.syncNowButton.addEventListener("click", async () => {
      await syncAll();
    });

    document.addEventListener("keydown", event => {
      const target = event.target;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (event.key === "/" && !isTyping && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        showScreen("contacts-panel");
        els.contactSearch.focus();
      }
    });

    els.logoutButton.addEventListener("click", async () => {
      try {
        await apiFetch("/auth/logout", { method: "POST" });
      } catch {
        // ignore session expiry
      }
      await handleSessionLoss();
    });

    document.querySelectorAll("[data-auth-mode]").forEach(button => {
      button.addEventListener("click", () => {
        const mode = button.dataset.authMode;
        document.querySelectorAll("[data-auth-mode]").forEach(b => {
          b.classList.toggle("active", b === button);
          b.setAttribute("aria-selected", String(b === button));
        });
        document.querySelectorAll("[data-auth-panel]").forEach(panel => {
          panel.classList.toggle("active", panel.dataset.authPanel === mode);
        });
      });
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

    if (els.csvImportForm) {
      els.csvImportForm.addEventListener("submit", handleCsvImport);
    }

    if (els.mobileDock) {
      els.mobileDock.addEventListener("click", event => {
        const button = event.target.closest("button[data-screen]");
        if (!button) {
          return;
        }
        showScreen(button.dataset.screen);
      });
    }

    if (els.backToContactsButton) {
      els.backToContactsButton.addEventListener("click", () => {
        showScreen("contacts-panel");
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
        navigator.serviceWorker.addEventListener("message", event => {
          if (event.data && event.data.type === "crm-run-sync") {
            syncAll();
          }
        });
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
    setBadge(els.syncStatusValue, error.message);
  });
})();