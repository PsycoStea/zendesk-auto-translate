// Popup script for Zendesk Auto Translator

document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.getElementById('toggleSwitch');
    const statusText = document.getElementById('statusText');
    const statusIndicator = document.querySelector('.status-indicator');
    const detectedLanguage = document.getElementById('detectedLanguage');
    const cacheStatus = document.getElementById('cacheStatus');
    const fallbackStatus = document.getElementById('fallbackStatus');
    const libreUrl = document.getElementById('libreUrl');
    const libreApiKey = document.getElementById('libreApiKey');
    const saveBtn = document.getElementById('saveBtn');
    const saveMsg = document.getElementById('saveMsg');
    const clearCacheBtn = document.getElementById('clearCacheBtn');
    const manageMacrosBtn = document.getElementById('manageMacrosBtn');

    const fallbackDetails = document.getElementById('fallbackDetails');

    chrome.storage.local.get(
        ['enabled', 'libretranslateUrl', 'libretranslateApiKey'],
        (result) => {
            const enabled = result.enabled !== false;
            toggleSwitch.checked = enabled;
            updateStatus(enabled);

            libreUrl.value = result.libretranslateUrl || '';
            libreApiKey.value = result.libretranslateApiKey || '';
            fallbackStatus.textContent = result.libretranslateUrl ? 'LibreTranslate' : 'Not configured';
            // Auto-expand the fallback section if one is already
            // configured — the agent likely opened the popup to edit
            // it, not to look at it collapsed.
            if (result.libretranslateUrl && fallbackDetails) {
                fallbackDetails.open = true;
            }
        }
    );

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && tabs[0].url.includes('zendesk.com')) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, (response) => {
                if (chrome.runtime.lastError) return;
                if (response) {
                    detectedLanguage.textContent = response.detectedLanguage || 'None';
                    cacheStatus.textContent = formatCacheStatus(
                        response.memorySize || 0,
                        response.cacheHits || 0,
                        response.cacheTotal || 0
                    );
                }
            });
        }
    });

    toggleSwitch.addEventListener('change', () => {
        const enabled = toggleSwitch.checked;
        chrome.storage.local.set({ enabled }, () => {
            updateStatus(enabled);
            chrome.tabs.query({ url: 'https://*.zendesk.com/*' }, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { action: 'toggle', enabled });
                });
            });
        });
    });

    saveBtn.addEventListener('click', async () => {
        saveMsg.textContent = '';
        saveMsg.className = 'save-msg';

        const rawUrl = libreUrl.value.trim().replace(/\/+$/, '');
        const apiKey = libreApiKey.value.trim();

        // Empty URL = fallback disabled. Any non-empty value must parse
        // as http(s) and the agent must grant host permission once so
        // the extension can actually call it from a Zendesk page.
        if (rawUrl) {
            let parsed;
            try { parsed = new URL(rawUrl); } catch (_) {
                return showSaveError('Server URL must be a valid URL, e.g. https://libretranslate.example.com');
            }
            if (!/^https?:$/.test(parsed.protocol)) {
                return showSaveError('Server URL must start with http:// or https://');
            }

            const originPattern = `${parsed.protocol}//${parsed.host}/*`;
            const granted = await requestHostPermission(originPattern);
            if (!granted) {
                return showSaveError('Permission for that host was denied. Fallback won\'t be able to reach it until you grant access.');
            }
        }

        chrome.storage.local.set(
            {
                libretranslateUrl: rawUrl,
                libretranslateApiKey: apiKey
            },
            () => {
                fallbackStatus.textContent = rawUrl ? 'LibreTranslate' : 'Not configured';
                saveMsg.textContent = 'Saved.';
                saveMsg.classList.add('success');
                chrome.tabs.query({ url: 'https://*.zendesk.com/*' }, (tabs) => {
                    tabs.forEach(tab => {
                        chrome.tabs.sendMessage(tab.id, { action: 'settingsUpdated' });
                    });
                });
                setTimeout(() => {
                    saveMsg.textContent = '';
                    saveMsg.className = 'save-msg';
                }, 3000);
            }
        );
    });

    // Manage macros (Phase 4 #13). Opens the macros editor in a new
    // tab. The page is at chrome-extension://<id>/macros.html, an
    // extension page with full chrome.* API access — it reads/writes
    // chrome.storage.local.macros directly, no message passing
    // through this popup needed.
    manageMacrosBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('macros.html') });
        // Close the popup so the agent ends up focused on the new tab.
        window.close();
    });

    clearCacheBtn.addEventListener('click', () => {
        clearCacheBtn.disabled = true;
        const originalLabel = clearCacheBtn.textContent;

        // Source of truth is chrome.storage.local — wiping it here (and
        // pushing the empty state to every open Zendesk tab so their
        // in-memory copies don't race us back on the next translate) is
        // safe even if no Zendesk tab is open.
        chrome.storage.local.set(
            { translationMemory: {}, cacheStats: { hits: 0, total: 0 } },
            () => {
                chrome.tabs.query({ url: 'https://*.zendesk.com/*' }, (tabs) => {
                    tabs.forEach(tab => {
                        chrome.tabs.sendMessage(tab.id, { action: 'clearCache' }, () => {
                            // Swallow runtime.lastError for tabs that haven't
                            // loaded the content script yet.
                            void chrome.runtime.lastError;
                        });
                    });
                });
                cacheStatus.textContent = formatCacheStatus(0, 0, 0);
                clearCacheBtn.textContent = 'Cleared ✓';
                setTimeout(() => {
                    clearCacheBtn.textContent = originalLabel;
                    clearCacheBtn.disabled = false;
                }, 1500);
            }
        );
    });

    function requestHostPermission(originPattern) {
        return new Promise((resolve) => {
            chrome.permissions.request({ origins: [originPattern] }, (granted) => {
                if (chrome.runtime.lastError) {
                    console.warn('permissions.request error:', chrome.runtime.lastError);
                    resolve(false);
                    return;
                }
                resolve(!!granted);
            });
        });
    }

    function updateStatus(enabled) {
        if (enabled) {
            statusText.textContent = 'Active';
            statusIndicator.classList.remove('inactive');
            statusIndicator.classList.add('active');
        } else {
            statusText.textContent = 'Disabled';
            statusIndicator.classList.remove('active');
            statusIndicator.classList.add('inactive');
        }
    }

    function formatCacheStatus(size, hits, total) {
        const entries = `${size} ${size === 1 ? 'entry' : 'entries'}`;
        if (!total) return entries;
        const pct = Math.round((hits / total) * 100);
        // Compact format: "10 entries · 55% hit". Drops the raw hits/total
        // ratio because it doesn't fit on one line at 320px popup width
        // alongside the "Cache" label and "Clear" button. The percentage
        // is the actually-useful number; raw counts only matter for
        // diagnostics and are still in chrome.storage.local for that.
        return `${entries} · ${pct}% hit`;
    }

    function showSaveError(msg) {
        saveMsg.textContent = msg;
        saveMsg.className = 'save-msg error';
    }
});
