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

    function beginEdit(name) {
        if (!confirmDiscardIfDirty()) return;
        const m = macros[name];
        if (!m) return;
        currentEditingName = name;
        elName.value = name;
        elBody.innerHTML = m.body || '';
        elDeleteBtn.disabled = false;
        showEditor();
        renderList();
        dirty = false;
        clearStatus();
        // Focus name field so the agent can rename quickly if needed.
        setTimeout(() => { try { elName.focus(); elName.select(); } catch (_) {} }, 0);
    }

    function beginCreate() {
        if (!confirmDiscardIfDirty()) return;
        currentEditingName = null;
        elName.value = '';
        elBody.innerHTML = '';
        elDeleteBtn.disabled = true;
        showEditor();
        renderList();
        dirty = false;
        clearStatus();
        setTimeout(() => { try { elName.focus(); } catch (_) {} }, 0);
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

        const existing = macros[newName] || {};
        macros[newName] = {
            body,
            attachments: existing.attachments || [],
            updated: Date.now(),
        };

        await saveMacros();
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
        showPlaceholder();
        renderList();
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
    // Boot
    // -----------------------------

    loadMacros().then(() => {
        renderList();
        showPlaceholder();
    });
})();
