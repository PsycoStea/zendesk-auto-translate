// Background service worker for Zendesk Auto Translator

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('Zendesk Auto Translator installed');

        chrome.storage.local.set({
            enabled: true,
            translationMemory: {},
            libretranslateUrl: '',
            libretranslateApiKey: ''
        });
    } else if (details.reason === 'update') {
        console.log('Zendesk Auto Translator updated to', chrome.runtime.getManifest().version);
        // Backfill newly-introduced settings without overwriting existing
        // ones. The `provider` key from older versions is intentionally
        // ignored now (Google is always primary, LibreTranslate is fallback
        // if configured); removing it here keeps storage tidy.
        chrome.storage.local.get(['provider', 'libretranslateUrl', 'libretranslateApiKey'], (r) => {
            const patch = {};
            if (r.libretranslateUrl === undefined) patch.libretranslateUrl = '';
            if (r.libretranslateApiKey === undefined) patch.libretranslateApiKey = '';
            if (Object.keys(patch).length) chrome.storage.local.set(patch);
            if (r.provider !== undefined) chrome.storage.local.remove('provider');
        });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    sendResponse({ received: true });
    return true;
});
