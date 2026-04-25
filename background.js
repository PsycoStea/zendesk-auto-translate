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
    // PDF fetch dispatch (v1.0.49). Background-SW fetches with
    // credentials: 'include' use the user's actual cookie jar for
    // hosts in host_permissions, so Zendesk's
    // /attachments/<token>/ redirector authenticates correctly and
    // follows through to the file on *.zdusercontent.com. Content-
    // script fetches in MV3 are treated as cross-origin from the
    // chrome-extension:// origin and don't get the cookies — that's
    // why v1.0.48's "Failed to fetch" happened.
    if (request && request.type === 'zt-fetch-pdf' && typeof request.url === 'string') {
        fetch(request.url, {
            credentials: 'include',
            redirect: 'follow',
        }).then(async (r) => {
            if (!r.ok) {
                throw new Error(`HTTP ${r.status} ${r.statusText}`);
            }
            const buf = await r.arrayBuffer();
            // ArrayBuffer transfers via structured clone — sendResponse
            // supports it. Wrap in object so the receiving side can
            // distinguish success from error shape without a type
            // discriminator on the buffer itself.
            sendResponse({ ok: true, data: buf, contentType: r.headers.get('content-type') });
        }).catch((err) => {
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
        // Keep the message channel open for the async sendResponse.
        return true;
    }

    // Default: ack and exit. Other messages flow through the content-
    // script-side listener.
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
