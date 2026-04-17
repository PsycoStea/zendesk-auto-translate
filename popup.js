// Popup script for Zendesk Auto Translator

document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.getElementById('toggleSwitch');
    const statusText = document.getElementById('statusText');
    const statusIndicator = document.querySelector('.status-indicator');
    const detectedLanguage = document.getElementById('detectedLanguage');
    const memorySize = document.getElementById('memorySize');
    const providerStatus = document.getElementById('providerStatus');
    const providerGoogle = document.getElementById('providerGoogle');
    const providerLibre = document.getElementById('providerLibre');
    const libreFields = document.getElementById('libreFields');
    const libreUrl = document.getElementById('libreUrl');
    const libreApiKey = document.getElementById('libreApiKey');
    const saveBtn = document.getElementById('saveBtn');
    const saveMsg = document.getElementById('saveMsg');

    const PROVIDER_LABEL = {
        google: 'Google Translate',
        libretranslate: 'LibreTranslate'
    };

    chrome.storage.local.get(
        ['enabled', 'provider', 'libretranslateUrl', 'libretranslateApiKey'],
        (result) => {
            const enabled = result.enabled !== false;
            toggleSwitch.checked = enabled;
            updateStatus(enabled);

            const provider = result.provider || 'google';
            providerGoogle.checked = provider === 'google';
            providerLibre.checked = provider === 'libretranslate';
            libreUrl.value = result.libretranslateUrl || '';
            libreApiKey.value = result.libretranslateApiKey || '';
            updateLibreVisibility();
            providerStatus.textContent = PROVIDER_LABEL[provider] || provider;
        }
    );

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && tabs[0].url.includes('zendesk.com')) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, (response) => {
                if (chrome.runtime.lastError) return;
                if (response) {
                    detectedLanguage.textContent = response.detectedLanguage || 'None';
                    memorySize.textContent = response.memorySize || 0;
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

    providerGoogle.addEventListener('change', updateLibreVisibility);
    providerLibre.addEventListener('change', updateLibreVisibility);

    saveBtn.addEventListener('click', async () => {
        saveMsg.textContent = '';
        saveMsg.className = 'save-msg';

        const provider = providerLibre.checked ? 'libretranslate' : 'google';
        const rawUrl = libreUrl.value.trim().replace(/\/+$/, '');
        const apiKey = libreApiKey.value.trim();

        if (provider === 'libretranslate') {
            if (!rawUrl) {
                return showSaveError('LibreTranslate server URL is required.');
            }
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
                return showSaveError('Permission for that host was denied. The extension cannot reach it until you grant access.');
            }
        }

        chrome.storage.local.set(
            {
                provider,
                libretranslateUrl: rawUrl,
                libretranslateApiKey: apiKey
            },
            () => {
                providerStatus.textContent = PROVIDER_LABEL[provider] || provider;
                saveMsg.textContent = 'Saved.';
                saveMsg.classList.add('success');
                // Tell open Zendesk tabs to refresh settings.
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

    function updateLibreVisibility() {
        if (providerLibre.checked) {
            libreFields.classList.add('visible');
        } else {
            libreFields.classList.remove('visible');
        }
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

    function showSaveError(msg) {
        saveMsg.textContent = msg;
        saveMsg.className = 'save-msg error';
    }
});
