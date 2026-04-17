// Background service worker for Zendesk Auto Translator

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('Zendesk Auto Translator installed');

        chrome.storage.local.set({
            enabled: true,
            translationMemory: {},
            provider: 'google',
            libretranslateUrl: '',
            libretranslateApiKey: ''
        });
    } else if (details.reason === 'update') {
        console.log('Zendesk Auto Translator updated to', chrome.runtime.getManifest().version);
        // Backfill any newly-introduced settings without overwriting existing ones.
        chrome.storage.local.get(['provider', 'libretranslateUrl', 'libretranslateApiKey'], (r) => {
            const patch = {};
            if (r.provider === undefined) patch.provider = 'google';
            if (r.libretranslateUrl === undefined) patch.libretranslateUrl = '';
            if (r.libretranslateApiKey === undefined) patch.libretranslateApiKey = '';
            if (Object.keys(patch).length) chrome.storage.local.set(patch);
        });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    sendResponse({ received: true });
    return true;
});
