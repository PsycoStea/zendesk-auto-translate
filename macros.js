// Manage Macros — settings page logic.
//
// Loaded by macros.html, runs in extension page context (chrome-
// extension:// origin) so it has direct access to chrome.storage.
//
// Storage shape (Phase 4 #13):
//   chrome.storage.local.macros = {
//     "<name>": { body: "<html>", attachments: [], updated: <timestamp> },
//     …
//   }
// Name is the unique key. Renaming a macro = delete-then-create. The
// composer-side autocomplete (in content.js) reads from the same map.

(function () {
    'use strict';

    // -----------------------------
    // DOM refs
    // -----------------------------
    const elList = document.getElementById('macroList');
    const elListEmpty = document.getElementById('macroListEmpty');
    const elFilter = document.getElementById('macroFilter');
    const elNewBtn = document.getElementById('newMacroBtn');
    const elPlaceholder = document.getElementById('editorPlaceholder');
    const elPanel = document.getElementById('editorPanel');
    const elName = document.getElementById('macroName');
    const elBody = document.getElementById('macroBody');
    const elToolbar = document.querySelector('.zt-macros-toolbar');
    const elSaveBtn = document.getElementById('saveMacroBtn');
    const elDeleteBtn = document.getElementById('deleteMacroBtn');
    const elSaveStatus = document.getElementById('saveStatus');

    // Per-macro options (v2.0.4+).
    const elAutoTranslateToggle = document.getElementById('autoTranslateToggle');

    // Attachment UI refs (Phase 4 #15).
    const elAttachmentsList = document.getElementById('attachmentsList');
    const elAttachmentInput = document.getElementById('attachmentInput');
    const elAddAttachmentBtn = document.getElementById('addAttachmentBtn');

    // Sync UI refs (Phase 4 #14).
    const elSyncPullBtn = document.getElementById('syncPullBtn');
    const elSyncPushBtn = document.getElementById('syncPushBtn');
    const elSyncSettingsBtn = document.getElementById('syncSettingsBtn');
    const elSyncSettingsPanel = document.getElementById('syncSettingsPanel');
    const elSyncToken = document.getElementById('syncToken');
    const elSyncSaveTokenBtn = document.getElementById('syncSaveTokenBtn');
    const elSyncClearTokenBtn = document.getElementById('syncClearTokenBtn');
    const elSyncStatus = document.getElementById('syncStatus');
    const elSyncLastInfo = document.getElementById('syncLastInfo');

    // -----------------------------
    // State
    // -----------------------------

    // Local mirror of chrome.storage.local.macros. Stays in sync via
    // the storage.onChanged listener so changes from another tab (or
    // future GitHub-sync, Phase 4 #14) flow into the UI.
    let macros = {};

    // Currently-edited macro's *original* name. null = creating new.
    // Tracks separately from the Name input so we can detect renames
    // (delete old key + write new key on save).
    let currentEditingName = null;

    // Dirty flag — set by any change to name/body, cleared on save.
    let dirty = false;

    // Staging area for the current macro's attachments (Phase 4 #15).
    // Mirrors what will become `macros[name].attachments` on save.
    // Each entry: { id, name, size, type } — the actual base64 blob is
    // stored separately under `chrome.storage.local.macroAttachments[id]`
    // and only loaded when needed (insertion in Zendesk reply).
    //   - When editing an existing macro we copy macros[name].attachments
    //     into this on beginEdit
    //   - On save we write it back into macros[name].attachments
    //   - On delete we tear down both metadata and any unreferenced blobs
    let currentAttachments = [];

    // Set of attachment ids that were uploaded during this edit
    // session but haven't been saved yet. If the user discards the
    // edit (or navigates away), we garbage-collect these blobs.
    let pendingAttachmentBlobIds = new Set();

    const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;   // 10 MB hard cap
    const ATTACHMENT_WARN_BYTES = 2 * 1024 * 1024;   // 2 MB soft warn

    // Sync state (Phase 4 #14). Mirrors chrome.storage.local.macroSync.
    //   token         — GitHub PAT for pushing. Null/undefined for
    //                   non-admin teammates (pull-only mode).
    //   lastPulledAt  — Unix ms when the last successful pull finished.
    //   lastPushedAt  — Unix ms when the last successful push finished.
    let syncState = { token: '', lastPulledAt: 0, lastPushedAt: 0 };

    // GitHub repo coordinates — hardcoded to keep config zero-touch for
    // everyone except the admin (who needs a token).
    const SYNC_REPO_OWNER = 'PsycoStea';
    const SYNC_REPO_NAME = 'zendesk-auto-translate-macros';
    const SYNC_REPO_BRANCH = 'main';
    const SYNC_PATH_PREFIX = 'macros';   // remote folder holding the JSON files

    // -----------------------------
    // Storage helpers
    // -----------------------------

    function loadMacros() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['macros'], (r) => {
                macros = (r && r.macros && typeof r.macros === 'object') ? r.macros : {};
                resolve(macros);
            });
        });
    }

    function saveMacros() {
        return new Promise((resolve) => {
            chrome.storage.local.set({ macros }, resolve);
        });
    }

    function loadSyncState() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['macroSync'], (r) => {
                const s = (r && r.macroSync && typeof r.macroSync === 'object') ? r.macroSync : {};
                syncState = {
                    token: s.token || '',
                    lastPulledAt: s.lastPulledAt || 0,
                    lastPushedAt: s.lastPushedAt || 0,
                };
                resolve(syncState);
            });
        });
    }

    function saveSyncState() {
        return new Promise((resolve) => {
            chrome.storage.local.set({ macroSync: syncState }, resolve);
        });
    }

    // -----------------------------
    // Attachment blob storage (Phase 4 #15)
    // -----------------------------
    //
    // PDF blobs are kept under `chrome.storage.local.macroAttachments`
    // as `{ <id>: <base64-string> }`. Storing them in chrome.storage
    // (rather than IndexedDB) means content.js can read them directly
    // without a service-worker round-trip — important for the synthetic
    // drop-event flow that attaches PDFs to the Zendesk reply on macro
    // insertion.
    //
    // Base64 inflates by ~33% but PDFs in macros are typically small
    // canned forms (a few hundred KB). We add the `unlimitedStorage`
    // permission so the 10MB default cap doesn't bite.

    function getAttachmentBlobIndex() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['macroAttachments'], (r) => {
                resolve((r && r.macroAttachments && typeof r.macroAttachments === 'object') ? r.macroAttachments : {});
            });
        });
    }

    function setAttachmentBlobIndex(index) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ macroAttachments: index }, resolve);
        });
    }

    async function storeAttachmentBlob(id, base64) {
        const index = await getAttachmentBlobIndex();
        index[id] = base64;
        await setAttachmentBlobIndex(index);
    }

    async function deleteAttachmentBlobs(ids) {
        if (!ids || ids.length === 0) return;
        const index = await getAttachmentBlobIndex();
        let changed = false;
        for (const id of ids) {
            if (id in index) { delete index[id]; changed = true; }
        }
        if (changed) await setAttachmentBlobIndex(index);
    }

    // Walk all saved macros and build a set of attachment ids that
    // are still referenced. Anything in macroAttachments that's not
    // in this set is orphaned and can be GC'd. Run this after deletes
    // and after pull-merges to keep storage clean.
    async function gcOrphanedAttachmentBlobs() {
        const index = await getAttachmentBlobIndex();
        const referenced = new Set();
        for (const macro of Object.values(macros)) {
            for (const att of macro.attachments || []) {
                if (att && att.id) referenced.add(att.id);
            }
        }
        const orphans = Object.keys(index).filter(id => !referenced.has(id));
        if (orphans.length === 0) return 0;
        for (const id of orphans) delete index[id];
        await setAttachmentBlobIndex(index);
        return orphans.length;
    }

    // base64 helpers — same shape as ghApi's, factored here so both
    // attachment code and sync code can use them.
    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // result is "data:application/pdf;base64,XXXX..." — strip the prefix
                const result = String(reader.result || '');
                const idx = result.indexOf(',');
                resolve(idx >= 0 ? result.slice(idx + 1) : result);
            };
            reader.onerror = () => reject(reader.error || new Error('read failed'));
            reader.readAsDataURL(file);
        });
    }

    function newAttachmentId() {
        // Random + timestamp so collisions are practically impossible
        // even across machines syncing through GitHub.
        return 'att_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    function fmtSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    // Pick up changes from other tabs / future sync.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes.macros) return;
        macros = changes.macros.newValue || {};
        renderList();
        // If the macro currently being edited was deleted elsewhere,
        // bail back to placeholder.
        if (currentEditingName && !(currentEditingName in macros)) {
            currentEditingName = null;
            showPlaceholder();
        }
    });

    // -----------------------------
    // Rendering
    // -----------------------------

    function renderList() {
        const filter = (elFilter.value || '').trim().toLowerCase();
        const allNames = Object.keys(macros).sort((a, b) => a.localeCompare(b));
        const visible = filter
            ? allNames.filter(n => n.toLowerCase().includes(filter))
            : allNames;

        elList.innerHTML = '';
        if (allNames.length === 0) {
            elListEmpty.style.display = '';
        } else {
            elListEmpty.style.display = 'none';
        }
        for (const name of visible) {
            const li = document.createElement('li');
            li.className = 'zt-macros-list-item';
            if (name === currentEditingName) li.classList.add('zt-macros-list-item-active');
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', name === currentEditingName ? 'true' : 'false');
            li.tabIndex = 0;

            const label = document.createElement('span');
            label.className = 'zt-macros-list-name';
            label.textContent = name;
            li.appendChild(label);

            li.addEventListener('click', () => beginEdit(name));
            li.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    beginEdit(name);
                }
            });
            elList.appendChild(li);
        }
    }

    function showPlaceholder() {
        elPanel.hidden = true;
        elPlaceholder.hidden = false;
        currentEditingName = null;
        dirty = false;
    }

    function showEditor() {
        elPlaceholder.hidden = true;
        elPanel.hidden = false;
    }

    // -----------------------------
    // Edit flow
    // -----------------------------

    async function beginEdit(name) {
        if (!confirmDiscardIfDirty()) return;
        await discardPendingAttachments();
        const m = macros[name];
        if (!m) return;
        currentEditingName = name;
        elName.value = name;
        elBody.innerHTML = m.body || '';
        elAutoTranslateToggle.checked = !!m.autoTranslate;
        // Clone the attachment metadata so edits don't mutate storage
        // until the user explicitly saves.
        currentAttachments = (m.attachments || []).map(a => Object.assign({}, a));
        elDeleteBtn.disabled = false;
        showEditor();
        renderList();
        renderAttachments();
        dirty = false;
        clearStatus();
        // Focus name field so the agent can rename quickly if needed.
        setTimeout(() => { try { elName.focus(); elName.select(); } catch (_) {} }, 0);
    }

    async function beginCreate() {
        if (!confirmDiscardIfDirty()) return;
        await discardPendingAttachments();
        currentEditingName = null;
        elName.value = '';
        elBody.innerHTML = '';
        elAutoTranslateToggle.checked = false;
        currentAttachments = [];
        elDeleteBtn.disabled = true;
        showEditor();
        renderList();
        renderAttachments();
        dirty = false;
        clearStatus();
        setTimeout(() => { try { elName.focus(); } catch (_) {} }, 0);
    }

    // If the user uploaded files but didn't save, drop those blobs
    // from storage so they don't accumulate as orphans.
    async function discardPendingAttachments() {
        if (pendingAttachmentBlobIds.size === 0) return;
        await deleteAttachmentBlobs([...pendingAttachmentBlobIds]);
        pendingAttachmentBlobIds.clear();
    }

    function confirmDiscardIfDirty() {
        if (!dirty) return true;
        return confirm('You have unsaved changes. Discard them?');
    }

    function validateName(raw) {
        const trimmed = (raw || '').trim();
        if (!trimmed) return { ok: false, error: 'Name is required.' };
        if (trimmed.length > 64) return { ok: false, error: 'Name must be 64 characters or fewer.' };
        if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
            return { ok: false, error: 'Name may only contain letters, numbers, hyphens, and underscores.' };
        }
        return { ok: true, name: trimmed };
    }

    async function saveCurrent() {
        const v = validateName(elName.value);
        if (!v.ok) {
            setStatus(v.error, 'error');
            elName.focus();
            return;
        }
        const newName = v.name;

        // Renaming or new name colliding with another macro.
        if (newName !== currentEditingName && newName in macros) {
            setStatus(`A macro named "${newName}" already exists.`, 'error');
            elName.focus();
            return;
        }

        const body = elBody.innerHTML.trim();
        if (!body || body === '<br>' || body === '<p><br></p>') {
            setStatus('Body cannot be empty.', 'error');
            elBody.focus();
            return;
        }

        // Rename: drop the old key.
        if (currentEditingName && currentEditingName !== newName) {
            delete macros[currentEditingName];
        }

        macros[newName] = {
            body,
            attachments: currentAttachments.map(a => Object.assign({}, a)),
            autoTranslate: !!elAutoTranslateToggle.checked,
            updated: Date.now(),
        };

        await saveMacros();
        // Pending blobs are now committed — they're referenced by the
        // saved macro, so they're no longer "pending" in the
        // discard-on-leave sense.
        pendingAttachmentBlobIds.clear();
        // Pick up any orphans (e.g. from removing an attachment, then
        // saving — the blob should disappear).
        await gcOrphanedAttachmentBlobs();
        currentEditingName = newName;
        elDeleteBtn.disabled = false;
        dirty = false;
        renderList();
        setStatus('Saved.', 'success');
        setTimeout(clearStatus, 2500);
    }

    async function deleteCurrent() {
        if (!currentEditingName) return;
        if (!confirm(`Delete "${currentEditingName}"? This can't be undone.`)) return;
        delete macros[currentEditingName];
        await saveMacros();
        // Drop any pending blobs from this edit session, then GC the
        // attachment store to remove anything that's now unreferenced.
        await discardPendingAttachments();
        await gcOrphanedAttachmentBlobs();
        currentAttachments = [];
        showPlaceholder();
        renderList();
        renderAttachments();
    }

    // -----------------------------
    // Status pill
    // -----------------------------

    function setStatus(msg, kind) {
        elSaveStatus.textContent = msg;
        elSaveStatus.className = 'zt-macros-save-status' + (kind ? ' zt-macros-save-status-' + kind : '');
    }
    function clearStatus() { setStatus('', null); }

    // -----------------------------
    // Attachment UI (Phase 4 #15)
    // -----------------------------

    function renderAttachments() {
        elAttachmentsList.innerHTML = '';
        for (const att of currentAttachments) {
            const item = document.createElement('div');
            item.className = 'zt-attachment-item';
            item.setAttribute('role', 'listitem');

            const icon = document.createElement('span');
            icon.className = 'zt-attachment-icon';
            icon.textContent = 'PDF';
            item.appendChild(icon);

            const nameEl = document.createElement('span');
            nameEl.className = 'zt-attachment-name';
            nameEl.textContent = att.name;
            nameEl.title = att.name;
            item.appendChild(nameEl);

            const sizeEl = document.createElement('span');
            sizeEl.className = 'zt-attachment-size';
            sizeEl.textContent = fmtSize(att.size || 0);
            item.appendChild(sizeEl);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'zt-attachment-remove';
            remove.setAttribute('aria-label', `Remove ${att.name}`);
            remove.title = 'Remove this attachment';
            remove.textContent = '✕';
            remove.addEventListener('click', () => removeAttachment(att.id));
            item.appendChild(remove);

            elAttachmentsList.appendChild(item);
        }
    }

    function removeAttachment(id) {
        const idx = currentAttachments.findIndex(a => a.id === id);
        if (idx < 0) return;
        currentAttachments.splice(idx, 1);
        // If this id was uploaded in *this* edit session, drop the blob
        // immediately. Otherwise leave it — it'll be GC'd on save.
        if (pendingAttachmentBlobIds.has(id)) {
            pendingAttachmentBlobIds.delete(id);
            deleteAttachmentBlobs([id]);
        }
        renderAttachments();
        markDirty();
    }

    async function handleAttachmentFiles(fileList) {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        const errors = [];
        let added = 0;
        for (const file of files) {
            // Hard requirement — PDFs only.
            if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
                errors.push(`${file.name}: not a PDF (skipped)`);
                continue;
            }
            if (file.size > ATTACHMENT_MAX_BYTES) {
                errors.push(`${file.name}: too large (${fmtSize(file.size)} > ${fmtSize(ATTACHMENT_MAX_BYTES)})`);
                continue;
            }
            if (file.size > ATTACHMENT_WARN_BYTES) {
                const ok = confirm(
                    `${file.name} is ${fmtSize(file.size)}. Large attachments slow macro insertion ` +
                    `and bloat the macros library. Add it anyway?`
                );
                if (!ok) continue;
            }
            try {
                const base64 = await fileToBase64(file);
                const id = newAttachmentId();
                await storeAttachmentBlob(id, base64);
                pendingAttachmentBlobIds.add(id);
                currentAttachments.push({
                    id,
                    name: file.name,
                    size: file.size,
                    type: file.type || 'application/pdf',
                });
                added++;
            } catch (err) {
                console.error('[zt-macro] failed to read attachment', file.name, err);
                errors.push(`${file.name}: ${err.message || 'read failed'}`);
            }
        }
        renderAttachments();
        if (added > 0) markDirty();
        if (errors.length > 0) {
            setStatus(errors.join(' · '), 'error');
        } else if (added > 0) {
            setStatus(`Added ${added} attachment${added === 1 ? '' : 's'}.`, 'success');
            setTimeout(clearStatus, 2500);
        }
    }

    elAddAttachmentBtn.addEventListener('click', () => {
        elAttachmentInput.value = '';   // allow re-selecting the same file
        elAttachmentInput.click();
    });

    elAttachmentInput.addEventListener('change', (ev) => {
        handleAttachmentFiles(ev.target.files);
    });

    // -----------------------------
    // Toolbar (execCommand-based)
    // -----------------------------
    //
    // execCommand is deprecated but still works in all current browsers
    // and is by far the simplest way to get rich-text editing inside a
    // contenteditable. The macro body is small enough that the
    // limitations (e.g. no nesting control) don't matter. If we ever
    // need finer-grained control we can swap in a small editor library
    // later — the storage shape is HTML strings, so the swap is
    // transparent to consumers.

    elToolbar.addEventListener('mousedown', (ev) => {
        // Prevent the toolbar buttons from stealing focus from the
        // contenteditable, which would collapse the selection and
        // make the format command no-op on whatever was highlighted.
        ev.preventDefault();
    });

    elToolbar.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-cmd]');
        if (!btn) return;
        const cmd = btn.dataset.cmd;
        if (cmd === 'createLink') {
            const url = prompt('Link URL (will be inserted as <a href="…">):');
            if (!url) return;
            document.execCommand('createLink', false, url);
        } else if (cmd === 'ztInsertCursor') {
            // Custom: insert the literal `{{cursor}}` text at the
            // current selection. Macro insertion (in content.js) walks
            // the inserted body for this token after the paste settles
            // and places the caret there, removing the marker.
            //
            // Refuse to insert a second one — multiple markers are
            // valid (we de-dupe on insertion) but pointless, and
            // visually noisy in the editor. Surface a status message
            // so the agent knows why nothing happened.
            if ((elBody.innerHTML || '').includes('{{cursor}}')) {
                setStatus('This macro already has a cursor marker.', null);
                setTimeout(clearStatus, 2500);
                elBody.focus();
                return;
            }
            elBody.focus();
            document.execCommand('insertText', false, '{{cursor}}');
        } else {
            document.execCommand(cmd, false, null);
        }
        elBody.focus();
        markDirty();
    });

    // -----------------------------
    // Wire input listeners
    // -----------------------------

    function markDirty() {
        if (!dirty) {
            dirty = true;
            clearStatus();
        }
    }

    elName.addEventListener('input', markDirty);
    elBody.addEventListener('input', markDirty);
    elAutoTranslateToggle.addEventListener('change', markDirty);

    elFilter.addEventListener('input', renderList);
    elNewBtn.addEventListener('click', beginCreate);
    elSaveBtn.addEventListener('click', saveCurrent);
    elDeleteBtn.addEventListener('click', deleteCurrent);

    // Cmd/Ctrl+S saves from anywhere in the editor.
    document.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 's' && !elPanel.hidden) {
            ev.preventDefault();
            saveCurrent();
        }
    });

    // Block leaving the page (or closing the tab) with unsaved
    // changes. The browser shows its own generic prompt — no custom
    // text is allowed in modern browsers.
    window.addEventListener('beforeunload', (ev) => {
        if (dirty) {
            ev.preventDefault();
            ev.returnValue = '';
        }
    });

    // -----------------------------
    // GitHub sync (Phase 4 #14)
    // -----------------------------
    //
    // The repo lives at PsycoStea/zendesk-auto-translate-macros (public).
    //
    // Pull: anonymous. Anyone can fetch the macros without setup —
    //   we list `macros/` via the unauthenticated GitHub Contents API,
    //   then fetch each file's `download_url` (raw.githubusercontent.com)
    //   to get the JSON. Per-IP rate limit is 60/hour which is fine for
    //   on-demand pulls.
    //
    // Push: requires a personal access token with Contents:read+write.
    //   Only the admin (team lead) needs one. Push uses the same
    //   Contents API (PUT to create/update, DELETE to remove). When a
    //   macro exists locally but not remotely we PUT-create; when it
    //   exists in both we PUT-update with sha; when it exists remotely
    //   but not locally and the user confirms, we DELETE.

    function ghApi(path, init) {
        // path starts with `/`. Returns the parsed JSON body for 2xx,
        // or throws with the GitHub `message` text for non-2xx.
        const url = `https://api.github.com${path}`;
        const headers = Object.assign({
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            // Defense against Chrome's HTTP cache serving stale data.
            // GitHub returns ETags + max-age headers; without these,
            // a list-then-PUT cycle could fetch a CACHED listing whose
            // SHA is older than the live one, then PUT with the stale
            // SHA, and GitHub rejects with "X does not match Y" (422).
            // Pragma is for legacy proxies; Cache-Control is the modern
            // way; `cache: 'no-store'` on the fetch options is the
            // belt-and-braces fix below.
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
        }, (init && init.headers) || {});
        if (syncState.token) {
            // Always send the token if we have it — even for reads,
            // because authenticated calls get the 5000/hour rate limit
            // instead of 60/hour.
            headers['Authorization'] = `Bearer ${syncState.token}`;
        }
        const fetchInit = Object.assign({ cache: 'no-store' }, init, { headers });
        return fetch(url, fetchInit).then(async (resp) => {
            const text = await resp.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (_) { body = { message: text }; }
            if (!resp.ok) {
                const err = new Error((body && body.message) || `GitHub API ${resp.status}`);
                err.status = resp.status;
                err.body = body;
                throw err;
            }
            return body;
        });
    }

    function nameToRemotePath(name) {
        // Names are validated to [A-Za-z0-9_-]+, so they're already
        // safe as path components. Lowercased for filesystem stability
        // (different OSes case-fold differently).
        return `${SYNC_PATH_PREFIX}/${name.toLowerCase()}.json`;
    }

    function macroToRemoteJson(name, macro) {
        // Pretty-printed so diffs in the GitHub UI are readable.
        // Local-only fields (id) are stripped — IDs are extension-
        // internal pointers into chrome.storage.local.macroAttachments
        // and have no meaning across browsers.
        const attachments = (macro.attachments || []).map(a => ({
            name: a.name,
            size: a.size || 0,
            type: a.type || 'application/pdf',
        }));
        return JSON.stringify({
            name,
            body: macro.body || '',
            updated: macro.updated || Date.now(),
            autoTranslate: !!macro.autoTranslate,
            attachments,
        }, null, 2);
    }

    // -----------------------------
    // Attachment sync helpers (Phase 4 #15 Phase C)
    // -----------------------------

    function sanitizeAttachmentFilename(name) {
        // Make a filename safe to use as a GitHub path segment.
        // Allow: alphanumerics, dot, dash, underscore.
        // Replace anything else with underscore. Collapse runs.
        // Preserve extension when truncating.
        let safe = (name || 'attachment.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
        safe = safe.replace(/^\.+/, '');     // no leading dots (.git etc.)
        safe = safe.replace(/_+/g, '_');     // collapse multiple underscores
        if (safe.length > 100) {
            const dot = safe.lastIndexOf('.');
            if (dot > 0 && dot >= safe.length - 8) {
                safe = safe.slice(0, 100 - (safe.length - dot)) + safe.slice(dot);
            } else {
                safe = safe.slice(0, 100);
            }
        }
        if (!safe || safe === '_') safe = 'attachment.pdf';
        return safe;
    }

    function macroAttachmentRemotePath(macroName, filename) {
        return `${SYNC_PATH_PREFIX}/${macroName.toLowerCase()}/${sanitizeAttachmentFilename(filename)}`;
    }

    function macroAttachmentFolderPath(macroName) {
        return `${SYNC_PATH_PREFIX}/${macroName.toLowerCase()}`;
    }

    async function listRemoteAttachmentsForMacro(macroName) {
        // Returns an array of file metadata or [] if the folder doesn't
        // exist yet. The folder gets created on first attachment push.
        try {
            const list = await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${macroAttachmentFolderPath(macroName)}?ref=${SYNC_REPO_BRANCH}`);
            return (Array.isArray(list) ? list : []).filter(f => f.type === 'file');
        } catch (err) {
            if (err.status === 404) return [];
            throw err;
        }
    }

    async function fetchAttachmentBlobBase64ByPath(macroName, filename) {
        // Pull binary content via raw.githubusercontent.com — works for
        // public repos with no auth and no rate limit (vs. the API's
        // 5000/hour). For files under 1MB we could also use the
        // contents endpoint with inline base64, but raw is consistent
        // for any size.
        const safeName = sanitizeAttachmentFilename(filename);
        const url = `https://raw.githubusercontent.com/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/${SYNC_REPO_BRANCH}/${SYNC_PATH_PREFIX}/${encodeURIComponent(macroName.toLowerCase())}/${encodeURIComponent(safeName)}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
        const blob = await resp.blob();
        return await fileToBase64(blob);
    }

    async function pushMacroAttachments(macroName, macro) {
        // Sync the attachment files for one macro. Uploads new/changed
        // files, deletes remote files that aren't referenced anymore.
        // Returns { uploaded, deleted, skipped, errors }.
        const result = { uploaded: 0, deleted: 0, skipped: 0, errors: [] };
        const localAttachments = macro.attachments || [];

        // Fetch remote folder listing once.
        let remoteFiles;
        try {
            remoteFiles = await listRemoteAttachmentsForMacro(macroName);
        } catch (err) {
            result.errors.push(`list ${macroName} attachments: ${err.message}`);
            return result;
        }
        const remoteByName = new Map();
        for (const f of remoteFiles) remoteByName.set(f.name, f);

        // Load all local blobs we'll need at once (chrome.storage round
        // trip is the bottleneck, not the GitHub API).
        const blobIndex = await getAttachmentBlobIndex();

        // Track sanitized names we're keeping so we know what to delete.
        const sanitizedKept = new Set();

        for (const att of localAttachments) {
            const safeName = sanitizeAttachmentFilename(att.name);
            sanitizedKept.add(safeName);
            const remoteFile = remoteByName.get(safeName);
            const blobBase64 = blobIndex[att.id];
            if (!blobBase64) {
                result.errors.push(`${macroName}/${att.name}: blob missing locally`);
                continue;
            }

            // Skip-if-unchanged: same size means we assume same bytes.
            // Cheap heuristic; rare false positives are tolerable for a
            // shared macro library. (We compare against the size we
            // recorded on upload, not the remote file — cross-checking
            // remote size would need an extra fetch.)
            if (remoteFile && remoteFile.size === att.size) {
                result.skipped++;
                continue;
            }

            const remotePath = macroAttachmentRemotePath(macroName, att.name);
            const body = {
                message: remoteFile
                    ? `Update attachment: ${macroName}/${safeName}`
                    : `Add attachment: ${macroName}/${safeName}`,
                content: blobBase64,
                branch: SYNC_REPO_BRANCH,
            };
            if (remoteFile) body.sha = remoteFile.sha;
            try {
                await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${remotePath}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                result.uploaded++;
            } catch (err) {
                result.errors.push(`${macroName}/${att.name}: ${err.message}`);
            }
        }

        // Delete remote attachment files no longer referenced locally.
        for (const f of remoteFiles) {
            if (sanitizedKept.has(f.name)) continue;
            try {
                await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${f.path}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: `Remove attachment: ${f.path}`,
                        sha: f.sha,
                        branch: SYNC_REPO_BRANCH,
                    }),
                });
                result.deleted++;
            } catch (err) {
                result.errors.push(`delete ${f.path}: ${err.message}`);
            }
        }

        return result;
    }

    async function pullMacroAttachments(macroName, remoteAttachments) {
        // Download each attachment listed in the remote macro JSON,
        // store its blob locally, return a fresh attachments array
        // with new local IDs. Failures are logged and the broken
        // attachment is dropped from the returned list — better to
        // pull the macro body without one PDF than fail the whole pull.
        const out = [];
        for (const att of remoteAttachments || []) {
            if (!att || !att.name) continue;
            try {
                const base64 = await fetchAttachmentBlobBase64ByPath(macroName, att.name);
                const newId = newAttachmentId();
                await storeAttachmentBlob(newId, base64);
                out.push({
                    id: newId,
                    name: att.name,
                    size: att.size || 0,
                    type: att.type || 'application/pdf',
                });
            } catch (err) {
                console.warn('[zt-sync] failed to pull attachment',
                    macroName, '/', att.name, ':', err.message || err);
            }
        }
        return out;
    }

    // base64 helpers — Contents API expects base64-encoded UTF-8 in
    // both directions. btoa()/atob() only work on Latin-1, so we route
    // through TextEncoder/Decoder to handle emoji and non-ASCII.
    function utf8ToBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
    function base64ToUtf8(b64) {
        const bin = atob(b64.replace(/\s+/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    async function listRemoteMacros() {
        // 404 means the `macros/` folder doesn't exist yet (fresh repo).
        // Treat as empty.
        try {
            const list = await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${SYNC_PATH_PREFIX}?ref=${SYNC_REPO_BRANCH}`);
            return (Array.isArray(list) ? list : []).filter(f => f.type === 'file' && f.name.endsWith('.json'));
        } catch (err) {
            if (err.status === 404) return [];
            throw err;
        }
    }

    async function pullFromGitHub() {
        setSyncStatus('Pulling…', 'busy');
        setSyncBusy(true);
        try {
            const remoteFiles = await listRemoteMacros();
            // Fetch each file's contents in parallel via download_url.
            // download_url points at raw.githubusercontent.com which has
            // its own rate limits (much higher than the API). For
            // private repos download_url is a temporary signed URL,
            // public repos get a stable one — both work the same way.
            const fetched = await Promise.all(remoteFiles.map(async (f) => {
                try {
                    const resp = await fetch(f.download_url, { cache: 'no-store' });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const text = await resp.text();
                    const data = JSON.parse(text);
                    return { ok: true, file: f, data };
                } catch (err) {
                    console.warn('[zt-sync] failed to fetch', f.path, err);
                    return { ok: false, file: f, error: err };
                }
            }));

            // Pull semantics: GitHub is the source of truth. For macros
            // that exist on the remote, we always replace the local
            // copy when the content differs — this matches how a user
            // intuits "Pull": after removing a PDF locally and clicking
            // Pull, they expect the PDF back from GitHub, not for their
            // accidental delete to win because it touched the local
            // `updated` timestamp.
            //
            // We DO preserve local-only macros (created but not yet
            // pushed) — pulling shouldn't destroy unpublished work.
            //
            // Skip-if-identical: if local body + attachments metadata
            // are exactly what the remote has, skip the macro entirely
            // (avoids re-downloading attachment blobs for no reason).
            const macroContentsEquivalent = (local, remote) => {
                if (!local) return false;
                if ((local.body || '') !== (remote.body || '')) return false;
                if (!!local.autoTranslate !== !!remote.autoTranslate) return false;
                const la = local.attachments || [];
                const ra = Array.isArray(remote.attachments) ? remote.attachments : [];
                if (la.length !== ra.length) return false;
                for (let i = 0; i < la.length; i++) {
                    if ((la[i].name || '') !== (ra[i].name || '')) return false;
                    if ((la[i].size || 0) !== (ra[i].size || 0)) return false;
                    if ((la[i].type || 'application/pdf') !== (ra[i].type || 'application/pdf')) return false;
                }
                return true;
            };

            let added = 0, updated = 0, skipped = 0;
            let attachmentsPulled = 0, attachmentsFailed = 0;
            for (const r of fetched) {
                if (!r.ok) { skipped++; continue; }
                const remote = r.data;
                if (!remote || typeof remote !== 'object' || !remote.name || typeof remote.body !== 'string') {
                    skipped++;
                    continue;
                }
                const remoteName = remote.name;
                const local = macros[remoteName];

                if (macroContentsEquivalent(local, remote)) {
                    skipped++;
                    continue;
                }

                // Pull attachment blobs for this macro.
                const remoteAttachments = Array.isArray(remote.attachments) ? remote.attachments : [];
                let localAttachments = [];
                if (remoteAttachments.length > 0) {
                    const before = remoteAttachments.length;
                    localAttachments = await pullMacroAttachments(remoteName, remoteAttachments);
                    attachmentsPulled += localAttachments.length;
                    attachmentsFailed += (before - localAttachments.length);
                }

                macros[remoteName] = {
                    body: remote.body,
                    attachments: localAttachments,
                    autoTranslate: !!remote.autoTranslate,
                    // Use remote's updated when available so the next
                    // push correctly sees this as already-synced. Fall
                    // back to now() if remote omitted the field.
                    updated: remote.updated || Date.now(),
                };
                if (local) updated++; else added++;
            }
            await saveMacros();

            syncState.lastPulledAt = Date.now();
            await saveSyncState();
            // Clean up any blobs that were referenced by a local macro
            // before the pull but aren't anymore. (Phase 4 #15 GitHub
            // sync of attachment blobs hasn't shipped yet, so for now
            // pulls can drop attachment refs whose blobs we still have
            // — those become orphans.)
            try { await gcOrphanedAttachmentBlobs(); } catch (_) {}
            renderList();
            renderSyncBar();

            const parts = [];
            if (added) parts.push(`${added} added`);
            if (updated) parts.push(`${updated} updated`);
            if (skipped) parts.push(`${skipped} skipped`);
            if (attachmentsPulled) parts.push(`${attachmentsPulled} attachment${attachmentsPulled === 1 ? '' : 's'}`);
            if (attachmentsFailed) parts.push(`${attachmentsFailed} attachment fail${attachmentsFailed === 1 ? '' : 's'}`);
            const summary = parts.length ? parts.join(', ') : 'already up to date';
            setSyncStatus(`Pulled ${remoteFiles.length} macros — ${summary}.`, attachmentsFailed ? 'error' : 'success');
        } catch (err) {
            console.error('[zt-sync] pull failed:', err);
            setSyncStatus(`Pull failed: ${err.message || err}`, 'error');
        } finally {
            setSyncBusy(false);
        }
    }

    async function pushToGitHub() {
        if (!syncState.token) {
            setSyncStatus('Push needs an admin token. Open Settings to enter one.', 'error');
            return;
        }
        setSyncStatus('Pushing…', 'busy');
        setSyncBusy(true);
        try {
            // 1. List remote so we know which files exist (and their shas).
            const remoteFiles = await listRemoteMacros();
            const remoteByName = new Map();
            for (const f of remoteFiles) {
                // Strip `.json` and the path prefix to recover the macro name.
                // e.g. "macros/order-cancelled.json" → "order-cancelled".
                const baseName = f.name.replace(/\.json$/i, '');
                remoteByName.set(baseName, f);
            }

            const localNames = Object.keys(macros);
            const localLowerSet = new Set(localNames.map(n => n.toLowerCase()));
            const toDeleteRemote = [];
            for (const [remoteName, file] of remoteByName) {
                if (!localLowerSet.has(remoteName)) toDeleteRemote.push(file);
            }

            if (toDeleteRemote.length > 0) {
                const ok = confirm(
                    `Push will delete ${toDeleteRemote.length} macro(s) from GitHub that no longer exist locally:\n\n` +
                    toDeleteRemote.map(f => '  • ' + f.name.replace(/\.json$/, '')).join('\n') +
                    `\n\nProceed with deletion?`
                );
                if (!ok) {
                    setSyncStatus('Push cancelled.', null);
                    return;
                }
            }

            let created = 0, updatedCount = 0, deleted = 0, skipped = 0;
            let attUploaded = 0, attDeleted = 0, attSkipped = 0;
            const attErrors = [];

            // 2. Upload each local macro that's new or changed,
            //    plus its attachment blobs.
            for (const name of localNames) {
                const macro = macros[name];
                const remotePath = nameToRemotePath(name);
                const remoteFile = remoteByName.get(name.toLowerCase());
                const newJson = macroToRemoteJson(name, macro);
                let jsonPushed = false;

                // If remote exists, compare bodies (avoid no-op commits).
                let jsonUnchanged = false;
                if (remoteFile) {
                    try {
                        const existing = await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${remotePath}?ref=${SYNC_REPO_BRANCH}`);
                        const existingJson = base64ToUtf8(existing.content || '');
                        if (existingJson === newJson) {
                            jsonUnchanged = true;
                        }
                    } catch (err) {
                        console.warn('[zt-sync] could not read existing remote', remotePath, err);
                    }
                }

                if (jsonUnchanged) {
                    skipped++;
                } else {
                    const body = {
                        message: remoteFile
                            ? `Update macro: ${name}`
                            : `Add macro: ${name}`,
                        content: utf8ToBase64(newJson),
                        branch: SYNC_REPO_BRANCH,
                    };
                    if (remoteFile) body.sha = remoteFile.sha;
                    await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${remotePath}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                    if (remoteFile) updatedCount++; else created++;
                    jsonPushed = true;
                }

                // Always sync attachments — pushMacroAttachments does
                // its own size-based skip-if-unchanged. Even a "skipped"
                // JSON might have stale remote attachments that need
                // cleaning up (folder created in a previous push that
                // failed mid-way).
                try {
                    const attResult = await pushMacroAttachments(name, macro);
                    attUploaded += attResult.uploaded;
                    attDeleted += attResult.deleted;
                    attSkipped += attResult.skipped;
                    if (attResult.errors.length) attErrors.push(...attResult.errors);
                } catch (err) {
                    attErrors.push(`${name} attachments: ${err.message}`);
                }

                void jsonPushed;   // keep var for future change detection
            }

            // 3. Delete remote JSON files for macros removed locally,
            //    plus their entire attachment folders.
            for (const file of toDeleteRemote) {
                const macroName = file.name.replace(/\.json$/, '');

                // Delete attachment files for this macro first (so the
                // folder is empty when we move on).
                try {
                    const orphans = await listRemoteAttachmentsForMacro(macroName);
                    for (const f of orphans) {
                        await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${f.path}`, {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                message: `Remove attachment (macro deleted): ${f.path}`,
                                sha: f.sha,
                                branch: SYNC_REPO_BRANCH,
                            }),
                        });
                        attDeleted++;
                    }
                } catch (err) {
                    attErrors.push(`cleanup ${macroName} attachments: ${err.message}`);
                }

                const body = {
                    message: `Delete macro: ${macroName}`,
                    sha: file.sha,
                    branch: SYNC_REPO_BRANCH,
                };
                await ghApi(`/repos/${SYNC_REPO_OWNER}/${SYNC_REPO_NAME}/contents/${file.path}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                deleted++;
            }

            syncState.lastPushedAt = Date.now();
            await saveSyncState();
            renderSyncBar();

            const parts = [];
            if (created) parts.push(`${created} added`);
            if (updatedCount) parts.push(`${updatedCount} updated`);
            if (deleted) parts.push(`${deleted} deleted`);
            if (skipped) parts.push(`${skipped} unchanged`);
            const attParts = [];
            if (attUploaded) attParts.push(`${attUploaded} att uploaded`);
            if (attDeleted) attParts.push(`${attDeleted} att deleted`);
            if (attSkipped) attParts.push(`${attSkipped} att unchanged`);
            const summary = parts.length ? parts.join(', ') : 'nothing to push';
            const attSummary = attParts.length ? ` · ${attParts.join(', ')}` : '';
            const errSummary = attErrors.length ? ` · ${attErrors.length} error(s)` : '';
            if (attErrors.length) {
                console.warn('[zt-sync] attachment push errors:', attErrors);
            }
            setSyncStatus(
                `Pushed — ${summary}${attSummary}${errSummary}.`,
                attErrors.length ? 'error' : 'success'
            );
        } catch (err) {
            console.error('[zt-sync] push failed:', err);
            let msg = err.message || String(err);
            if (err.status === 401) msg = 'Token rejected (401). Generate a new one and try again.';
            if (err.status === 403) msg = 'Token lacks Contents:write permission, or rate limit hit.';
            if (err.status === 404) msg = 'Repo not found. Check the repo exists and the token has access.';
            setSyncStatus(`Push failed: ${msg}`, 'error');
        } finally {
            setSyncBusy(false);
        }
    }

    // -----------------------------
    // Sync UI
    // -----------------------------

    function setSyncStatus(msg, kind) {
        elSyncStatus.textContent = msg || '';
        elSyncStatus.className = 'zt-sync-status' + (kind ? ' zt-sync-status-' + kind : '');
    }

    function setSyncBusy(busy) {
        elSyncPullBtn.disabled = busy;
        elSyncPushBtn.disabled = busy || !syncState.token;
        elSyncPullBtn.dataset.busy = busy ? '1' : '0';
    }

    function fmtRelative(ts) {
        if (!ts) return null;
        const delta = Date.now() - ts;
        if (delta < 60_000) return 'just now';
        if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
        if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
        return new Date(ts).toLocaleDateString();
    }

    function renderSyncBar() {
        const parts = [];
        if (syncState.lastPulledAt) parts.push(`pulled ${fmtRelative(syncState.lastPulledAt)}`);
        if (syncState.lastPushedAt) parts.push(`pushed ${fmtRelative(syncState.lastPushedAt)}`);
        elSyncLastInfo.textContent = parts.length ? parts.join(' · ') : 'Not synced yet.';
        const busy = elSyncPullBtn.dataset.busy === '1';
        elSyncPushBtn.disabled = !syncState.token || busy;
        elSyncPushBtn.title = syncState.token
            ? 'Upload local macros to GitHub (admin only)'
            : 'Push needs an admin token — open Settings to add one';
    }

    elSyncPullBtn.addEventListener('click', () => { pullFromGitHub(); });
    elSyncPushBtn.addEventListener('click', () => { pushToGitHub(); });

    elSyncSettingsBtn.addEventListener('click', () => {
        const showing = !elSyncSettingsPanel.hidden;
        elSyncSettingsPanel.hidden = showing;
        if (!showing) {
            // Don't put the existing token into a visible field —
            // password type already hides it but the value is still
            // copyable. Show a placeholder telling them what's stored.
            elSyncToken.value = '';
            elSyncToken.placeholder = syncState.token
                ? '(token saved — paste a new one to replace)'
                : 'ghp_… or github_pat_…';
            try { elSyncToken.focus(); } catch (_) {}
        }
    });

    elSyncSaveTokenBtn.addEventListener('click', async () => {
        const t = (elSyncToken.value || '').trim();
        if (!t) {
            setSyncStatus('Enter a token first.', 'error');
            return;
        }
        // Light sanity check — fine-grained tokens start with
        // `github_pat_`, classic tokens with `ghp_`. Don't reject
        // unrecognized prefixes (GitHub may add new formats), just warn.
        if (!/^gh[ps]_|^github_pat_/.test(t)) {
            const ok = confirm("That doesn't look like a GitHub token. Save anyway?");
            if (!ok) return;
        }
        syncState.token = t;
        await saveSyncState();
        elSyncToken.value = '';
        elSyncSettingsPanel.hidden = true;
        renderSyncBar();
        setSyncStatus('Token saved.', 'success');
    });

    elSyncClearTokenBtn.addEventListener('click', async () => {
        if (!syncState.token) {
            setSyncStatus('No token to forget.', null);
            return;
        }
        if (!confirm('Forget the GitHub token? You can paste a new one later.')) return;
        syncState.token = '';
        await saveSyncState();
        elSyncToken.value = '';
        renderSyncBar();
        setSyncStatus('Token forgotten.', null);
    });

    // -----------------------------
    // Boot
    // -----------------------------

    Promise.all([loadMacros(), loadSyncState()]).then(async () => {
        renderList();
        renderSyncBar();
        renderAttachments();
        showPlaceholder();
        // Best-effort cleanup of orphaned attachment blobs on every
        // boot. Cheap and protects against partial-failure leftovers.
        try {
            const gc = await gcOrphanedAttachmentBlobs();
            if (gc > 0) console.log('[zt-macro] GC dropped', gc, 'orphaned attachment blobs');
        } catch (_) {}
    });

    // Theme reporter — same pattern as popup.js. Updates the toolbar
    // icon when the macros editor tab is open and the user changes
    // theme.
    (function reportToolbarTheme() {
        try {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const send = () => {
                try {
                    chrome.runtime.sendMessage(
                        { type: 'updateToolbarIcon', dark: mq.matches },
                        () => { void chrome.runtime.lastError; }
                    );
                } catch (_) {}
            };
            send();
            mq.addEventListener('change', send);
        } catch (_) {}
    })();
})();
