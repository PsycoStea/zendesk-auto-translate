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

// Keyboard shortcut dispatch. The `translate-reply` command is registered
// in manifest.json with Cmd/Ctrl+Shift+X as the default. Forward the press
// to the active Zendesk tab's content script; the content script decides
// what to do based on the visible ticket's state (reply button present,
// language detected, etc).
chrome.commands.onCommand.addListener((command) => {
    if (command !== 'translate-reply') return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url || !tab.url.includes('zendesk.com')) return;
        chrome.tabs.sendMessage(tab.id, { action: 'shortcut-translate-reply' }, () => {
            // Swallow runtime.lastError if the content script isn't loaded
            // (e.g. on a non-matched subpath) — nothing to do.
            void chrome.runtime.lastError;
        });
    });
});
