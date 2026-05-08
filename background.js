// Background service worker for Zendesk Auto Translator

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('Zendesk Auto Translator installed');

        chrome.storage.local.set({
            enabled: true,
            translationMemory: {},
            libretranslateUrl: '',
            libretranslateApiKey: '',
            macros: {}  // Phase 4 #13
        });
    } else if (details.reason === 'update') {
        console.log('Zendesk Auto Translator updated to', chrome.runtime.getManifest().version);
        // Backfill newly-introduced settings without overwriting existing
        // ones. The `provider` key from older versions is intentionally
        // ignored now (Google is always primary, LibreTranslate is fallback
        // if configured); removing it here keeps storage tidy.
        chrome.storage.local.get(['provider', 'libretranslateUrl', 'libretranslateApiKey', 'macros'], (r) => {
            const patch = {};
            if (r.libretranslateUrl === undefined) patch.libretranslateUrl = '';
            if (r.libretranslateApiKey === undefined) patch.libretranslateApiKey = '';
            if (r.macros === undefined) patch.macros = {};  // Phase 4 #13 default
            if (Object.keys(patch).length) chrome.storage.local.set(patch);
            if (r.provider !== undefined) chrome.storage.local.remove('provider');
        });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // v1.0.49 added a `zt-fetch-pdf` handler here that fetched the PDF
    // bytes server-side and returned them via sendResponse. That
    // approach failed because `chrome.runtime.sendMessage` is JSON-
    // only — `ArrayBuffer` got serialized to `undefined`. v1.0.50
    // moved the credentialed fetch into the PDF.js viewer iframe
    // itself (extension pages can fetch host_permissions origins with
    // cookies via the user's cookie jar), so the round-trip through
    // background isn't needed.

    // Theme-aware toolbar icon (v2.0.7). The `theme_icons` manifest
    // field doesn't switch live in current Chrome stable — the icon
    // sticks on whichever variant Chrome rendered first. Fall back to
    // a JS-based switch: extension pages and content scripts detect
    // `prefers-color-scheme` via matchMedia and message us; we call
    // chrome.action.setIcon to update the toolbar icon explicitly.
    if (request && request.type === 'updateToolbarIcon') {
        const suffix = request.dark ? '-dark' : '';
        try {
            chrome.action.setIcon({
                path: {
                    16: `icon16${suffix}.png`,
                    48: `icon48${suffix}.png`,
                    128: `icon128${suffix}.png`,
                },
            }, () => {
                // setIcon doesn't return a value; swallow lastError to
                // avoid unhandled-promise warnings if the path is
                // missing on disk.
                void chrome.runtime.lastError;
            });
        } catch (_) {}
        sendResponse({ received: true });
        return true;
    }

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
