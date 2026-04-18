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

    chrome.storage.local.get(
        ['enabled', 'libretranslateUrl', 'libretranslateApiKey'],
        (result) => {
            const enabled = result.enabled !== false;
            toggleSwitch.checked = enabled;
            updateStatus(enabled);

            libreUrl.value = result.libretranslateUrl || '';
            libreApiKey.value = result.libretranslateApiKey || '';
            fallbackStatus.textContent = result.libretranslateUrl ? 'LibreTranslate' : 'Not configured';
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
        return `${entries} · ${hits}/${total} hits (${pct}%)`;
    }

    function showSaveError(msg) {
        saveMsg.textContent = msg;
        saveMsg.className = 'save-msg error';
    }
});
