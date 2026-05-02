// Zendesk Auto Translator - Content Script
// This script runs on all Zendesk pages and handles translation

(function() {
    'use strict';

    // Pure / DOM-only helpers live in src/translate-core.js (loaded by
    // the manifest's content_scripts[0].js array before this file). They
    // expose themselves as `window.__ztCore` in the browser; we
    // destructure them here so the rest of this file can use them as
    // bare identifiers without changing every call site. Tests in
    // tests/ require the same module under Node directly.
    const {
        escapeHtml,
        makeUrlToken,
        protectUrls,
        restoreUrls,
        splitCommentAtFirstBlockquote,
        serializeNodeAsMarkdown,
        htmlToMarkdownish,
        markdownishToHtml,
        stripMarkdownSyntax,
        extractEnglishSourceFromMarkdown,
    } = window.__ztCore;

    // ============================================
    // STORAGE & STATE MANAGEMENT
    // ============================================

    let detectedCustomerLanguage = null;
    let translationMemory = {};
    let isEnabled = true;
    const settings = {
        libretranslateUrl: '',
        libretranslateApiKey: ''
    };

    // Hidden developer flag for verbose translator + debug-pipeline logs.
    // Lifecycle logs (init/ready), warnings, and console.error are always
    // on. Toggle via DevTools console:
    //   chrome.storage.local.set({ztDebug: true})   // enable
    //   chrome.storage.local.remove('ztDebug')      // disable
    // Read once at init and kept in sync via storage.onChanged so the flag
    // can be flipped without reloading the tab.
    let ztDebug = false;
    const ztDbg = {
        log: (...args) => { if (ztDebug) console.log(...args); },
        groupCollapsed: (label) => { if (ztDebug) console.groupCollapsed(label); },
        groupEnd: () => { if (ztDebug) console.groupEnd(); }
    };

    // Google rate-limit cool-off. When googleTranslate / googleDetect see
    // an HTTP 429, this is set to Date.now() + 60_000. While in effect,
    // Google calls are skipped entirely — translateParagraph / detectLanguage
    // go straight to LibreTranslate (when configured) or surface an error
    // toast. Avoids hammering Google during the cool-down and unlocks the
    // fallback for the full window instead of 429ing every call.
    let googleCooloffUntil = 0;
    function inGoogleCooloff() { return Date.now() < googleCooloffUntil; }
    function googleCooloffSecondsLeft() {
        return Math.max(0, Math.ceil((googleCooloffUntil - Date.now()) / 1000));
    }

    // Ticket-wide language lock. Once we've detected a customer's language
    // for a ticket (e.g. ticket 3165645 is in German), we remember it
    // forever — every new message in that ticket short-circuits straight
    // to the locked language without re-hitting the detection endpoint.
    // Saves API calls and prevents flicker when one of the customer's
    // replies happens to round-trip through detection as a different
    // language (short messages or numbers-heavy text are unstable).
    //
    // Per-message data-zt-lang stays as a secondary cache: it's ephemeral
    // (lives on a DOM node) but covers the case where Zendesk has multiple
    // tickets open in the same DOM and we can't tell which ticket a hidden
    // message belongs to (getTicketIdFromUrl only knows the *visible*
    // ticket).
    //
    // Invalidation: future Phase 2 #8 language-override dropdown writes to
    // this same map. No automatic expiry.
    let ticketLanguages = {};
    function persistTicketLanguages() {
        // Direct write — these updates are at most once per ticket open
        // (first message detection) so debouncing buys nothing.
        safeStorageSet({ ticketLanguages });
    }

    function normalizeUrl(u) {
        return (u || '').trim().replace(/\/+$/, '');
    }

    // Cache hit/total counters. Persisted to chrome.storage.local so the
    // numbers accumulate across Chrome restarts (and across tabs). Loaded
    // on init; writes are debounced to coalesce bursts of translate calls
    // into a single storage write.
    const cacheStats = { hits: 0, total: 0 };

    // Max entries kept in translationMemory. v1.0.29 field data across two
    // agents over 4 days showed hit rates of 79% and 86% at a 100-entry
    // cap — the cache was constantly evicting. 2000 entries ≈ 3MB of
    // storage, well under Chrome's 5MB default quota, and gives hot
    // templates and boilerplate room to stay resident.
    const CACHE_MAX = 2000;

    // Combined debounced writer for cacheStats + translationMemory. Both
    // get dirty on every translate call (total++, and either a LRU bump
    // on hit or a new-entry insert on miss) — coalescing into a single
    // storage write per 1s keeps disk I/O sane during burst activity.
    let storageWriteTimer = null;
    let memoryDirty = false;
    let statsDirty = false;
    function scheduleStorageWrite() {
        if (storageWriteTimer) return;
        storageWriteTimer = setTimeout(() => {
            storageWriteTimer = null;
            const payload = {};
            if (statsDirty) {
                payload.cacheStats = { hits: cacheStats.hits, total: cacheStats.total };
                statsDirty = false;
            }
            if (memoryDirty) {
                payload.translationMemory = translationMemory;
                memoryDirty = false;
            }
            if (Object.keys(payload).length) safeStorageSet(payload);
        }, 1000);
    }

    function persistCacheStats() {
        statsDirty = true;
        scheduleStorageWrite();
    }

    function persistMemory() {
        memoryDirty = true;
        scheduleStorageWrite();
    }

    chrome.storage.local.get(
        ['enabled', 'translationMemory', 'libretranslateUrl', 'libretranslateApiKey', 'cacheStats', 'ztDebug', 'ticketLanguages', 'ztMigrations'],
        (result) => {
            isEnabled = result.enabled !== false;
            translationMemory = result.translationMemory || {};
            settings.libretranslateUrl = normalizeUrl(result.libretranslateUrl);
            settings.libretranslateApiKey = result.libretranslateApiKey || '';
            ztDebug = !!result.ztDebug;
            ticketLanguages = (result.ticketLanguages && typeof result.ticketLanguages === 'object') ? result.ticketLanguages : {};

            // v1.0.43 one-time migration: clear all auto-populated
            // ticketLanguages entries. Phase 1 #6's lock is rolled back
            // (see release notes) — historical entries are mostly first-
            // message auto-detections, some of which were wrong and
            // forced subsequent messages through the bad lock. We can't
            // distinguish auto-set from manually-overridden post-hoc,
            // so we clear everything once. Manual dropdown overrides
            // made *after* this upgrade will persist normally (the
            // dropdown writes to the same map; subsequent loads see the
            // migration flag and skip the clear).
            //
            // Gated by ztMigrations.clearTicketLockV2 so it runs exactly
            // once per browser profile.
            const migrations = (result.ztMigrations && typeof result.ztMigrations === 'object') ? result.ztMigrations : {};
            if (!migrations.clearTicketLockV2) {
                const cleared = Object.keys(ticketLanguages).length;
                ticketLanguages = {};
                migrations.clearTicketLockV2 = true;
                safeStorageSet({ ticketLanguages: {}, ztMigrations: migrations });
                if (cleared) console.log(`[zt] v1.0.43 migration: cleared ${cleared} stale ticket-language lock entries`);
            }
            if (result.cacheStats && typeof result.cacheStats === 'object') {
                cacheStats.hits = Number(result.cacheStats.hits) || 0;
                cacheStats.total = Number(result.cacheStats.total) || 0;
            }

            if (isEnabled) {
                console.log('Zendesk Auto Translator: Enabled (Google primary, LibreTranslate fallback ' +
                    (settings.libretranslateUrl ? 'configured)' : 'not configured)'));
                init();
            }
        }
    );

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.libretranslateUrl) settings.libretranslateUrl = normalizeUrl(changes.libretranslateUrl.newValue);
        if (changes.libretranslateApiKey) settings.libretranslateApiKey = changes.libretranslateApiKey.newValue || '';
        if (changes.ztDebug) ztDebug = !!changes.ztDebug.newValue;
        if (changes.ticketLanguages && changes.ticketLanguages.newValue) {
            ticketLanguages = changes.ticketLanguages.newValue;
        }
        if (changes.macros) {
            macros = (changes.macros.newValue && typeof changes.macros.newValue === 'object')
                ? changes.macros.newValue
                : {};
            // If the dropdown is open while macros change, refresh its
            // filtered list — the agent might have just renamed a
            // macro from another tab.
            if (macroAutocomplete.menu) {
                macroAutocomplete.items = filterMacrosByPartial(macroAutocomplete.partial);
                macroAutocomplete.activeIndex = Math.min(
                    macroAutocomplete.activeIndex,
                    Math.max(0, macroAutocomplete.items.length - 1)
                );
                renderMacroMenu();
            }
        }
        // If another Zendesk tab (or a service worker) updated the cache
        // stats, pick up the newer value. Guard against our own pending
        // write losing counts — only take the incoming value if it's at
        // least as high as ours for both counters.
        if (changes.cacheStats && changes.cacheStats.newValue) {
            const v = changes.cacheStats.newValue;
            const incomingTotal = Number(v.total) || 0;
            const incomingHits = Number(v.hits) || 0;
            if (incomingTotal >= cacheStats.total) {
                cacheStats.total = incomingTotal;
                cacheStats.hits = incomingHits;
            }
        }
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'toggle') {
            isEnabled = request.enabled;
            if (isEnabled) init(); else cleanup();
            sendResponse({ success: true });
        } else if (request.action === 'getStatus') {
            sendResponse({
                enabled: isEnabled,
                detectedLanguage: detectedCustomerLanguage ? getLanguageDisplay(detectedCustomerLanguage) : null,
                memorySize: Object.keys(translationMemory).length,
                cacheHits: cacheStats.hits,
                cacheTotal: cacheStats.total,
                fallbackConfigured: !!settings.libretranslateUrl
            });
        } else if (request.action === 'settingsUpdated') {
            // storage.onChanged handles the actual refresh; just acknowledge.
            sendResponse({ success: true });
        } else if (request.action === 'shortcut-translate-reply') {
            // Keyboard shortcut from background.js (default Cmd/Ctrl+Shift+X).
            // Find the reply-translate button in the visible ticket's
            // toolbar and click it. addReplyTranslateButton() is idempotent —
            // calling it first ensures the button exists if scanAndAttach
            // hasn't placed it yet (e.g. agent hit the shortcut before the
            // first poll tick after a ticket switch).
            if (!isEnabled) {
                sendResponse({ success: false, reason: 'disabled' });
                return;
            }
            addReplyTranslateButton();
            const btn = findVisibleReplyButton();
            if (btn) {
                btn.click();
                sendResponse({ success: true });
            } else {
                showToast('No customer language detected yet — open a non-English ticket first.', 'warn');
                sendResponse({ success: false, reason: 'no-button' });
            }
        } else if (request.action === 'clearCache') {
            // Popup's Clear button. Drop the in-memory cache + counters and
            // cancel any pending debounced write so it can't revive them,
            // then persist the empty state immediately so a page reload or
            // another tab sees the cleared cache without waiting for the
            // next translate call.
            translationMemory = {};
            cacheStats.hits = 0;
            cacheStats.total = 0;
            memoryDirty = false;
            statsDirty = false;
            if (storageWriteTimer) { clearTimeout(storageWriteTimer); storageWriteTimer = null; }
            safeStorageSet({
                translationMemory: {},
                cacheStats: { hits: 0, total: 0 }
            });
            sendResponse({ success: true });
        }
    });

    // ============================================
    // EXTENSION CONTEXT GUARD
    // ============================================
    //
    // When the extension is reloaded while a Zendesk tab is open, the content
    // script in that tab loses its connection to chrome.* APIs. Any call to
    // chrome.storage / chrome.runtime throws "Extension context invalidated."
    // Guard the entry points and warn the user once so translation errors
    // don't masquerade as provider failures.

    let contextInvalidatedNotified = false;

    function isExtensionContextValid() {
        try { return !!(chrome.runtime && chrome.runtime.id); }
        catch (_) { return false; }
    }

    function guardExtensionContext() {
        if (isExtensionContextValid()) return true;
        if (!contextInvalidatedNotified) {
            contextInvalidatedNotified = true;
            try { showToast('Extension was reloaded — please refresh this Zendesk tab.', 'warn'); } catch (_) {}
        }
        return false;
    }

    function safeStorageSet(obj) {
        if (!isExtensionContextValid()) return;
        try { chrome.storage.local.set(obj); } catch (_) { /* context gone between checks */ }
    }

    // ============================================
    // TOAST HELPER
    // ============================================

    function showToast(message, kind = 'info') {
        try {
            const el = document.createElement('div');
            el.className = `zt-toast zt-toast-${kind}`;
            el.textContent = message;
            document.body.appendChild(el);
            requestAnimationFrame(() => el.classList.add('zt-toast-show'));
            setTimeout(() => {
                el.classList.remove('zt-toast-show');
                setTimeout(() => el.remove(), 300);
            }, 4000);
        } catch (_) {
            // body may not be ready; silent.
        }
    }

    // ============================================
    // TRANSLATION API (provider-aware)
    // ============================================

    const REQUEST_TIMEOUT_MS = 8000;

    async function fetchWithTimeout(url, options = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...options, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    function readableError(err, providerLabel) {
        if (err && err.name === 'AbortError') return `${providerLabel} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
        return `${providerLabel} error: ${(err && err.message) || err}`;
    }

    // Both Google calls share rate-limit handling. On HTTP 429 we set a
    // 60s cool-off and throw a typed error so callers (translateParagraph,
    // detectLanguage) can decide whether to fall back to LibreTranslate or
    // surface a toast. Throwing a typed error rather than returning a
    // sentinel means the existing try/catch fallback chain works unchanged
    // for non-429 errors too.
    function makeRateLimitError() {
        const err = new Error(`Google Translate rate-limited (HTTP 429). Cooling off for 60s.`);
        err.code = 'rate-limited';
        return err;
    }

    async function googleDetect(text) {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text.slice(0, 500))}`;
        const res = await fetchWithTimeout(url);
        if (res.status === 429) {
            googleCooloffUntil = Date.now() + 60_000;
            throw makeRateLimitError();
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data[2] || 'unknown';
    }

    async function googleTranslate(text, target, source) {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetchWithTimeout(url);
        if (res.status === 429) {
            googleCooloffUntil = Date.now() + 60_000;
            throw makeRateLimitError();
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        let out = '';
        if (data[0]) data[0].forEach(item => { if (item[0]) out += item[0]; });
        return out;
    }

    function requireLibreUrl() {
        if (!settings.libretranslateUrl) {
            throw new Error('Server URL not set. Open the extension popup to configure it.');
        }
        return settings.libretranslateUrl;
    }

    async function libreFetch(path, body) {
        const base = requireLibreUrl();
        if (settings.libretranslateApiKey) body.api_key = settings.libretranslateApiKey;
        const res = await fetchWithTimeout(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.json()).error || ''; } catch (_) {}
            throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
        }
        return res.json();
    }

    async function libreDetect(text) {
        const data = await libreFetch('/detect', { q: text.slice(0, 500) });
        const top = Array.isArray(data) ? data[0] : data;
        return (top && top.language) || 'unknown';
    }

    async function libreTranslate(text, target, source) {
        const data = await libreFetch('/translate', {
            q: text,
            source: source || 'auto',
            target,
            format: 'text'
        });
        return data.translatedText || '';
    }

    // Language detection uses the same primary-fallback chain as
    // translation: try Google first, fall back to LibreTranslate if
    // configured. On both-failed, return 'unknown' and toast once.
    async function detectLanguage(text) {
        if (!guardExtensionContext()) return 'unknown';

        // During cool-off, go straight to LibreTranslate when configured;
        // otherwise return 'unknown' silently (no toast — detection runs
        // automatically per message, and one toast per translateParagraph
        // failure is already plenty of feedback for the rate-limit state).
        if (inGoogleCooloff()) {
            if (!settings.libretranslateUrl) return 'unknown';
            try { return await libreDetect(text); }
            catch (_) { return 'unknown'; }
        }

        try {
            return await googleDetect(text);
        } catch (googleErr) {
            if (settings.libretranslateUrl) {
                try {
                    return await libreDetect(text);
                } catch (_) {
                    // fall through to toast + unknown
                }
            }
            console.error('[zt] Language detection error:', googleErr);
            showToast(readableError(googleErr, 'Google Translate'), 'error');
            return 'unknown';
        }
    }

    // Bump when the translation pipeline changes in a way that would make
    // previously-cached results look wrong (e.g. paragraph-splitting, HTML
    // formatting preservation). Old entries with a different prefix become
    // unreachable and naturally evicted by the LRU trim.
    const CACHE_VERSION = 'v6';

    // Translators sometimes mangle markdown-style links ([text](url)) —
    // moving the brackets around, dropping the URL, or translating words
    // inside the URL. To preserve hyperlinks and bare URLs exactly,
    // replace every URL with a {{ztlink<N>}} token before translating
    // and swap the real URL back after. Tokens shaped like Zendesk
    // placeholders ride through translators unchanged (we've seen Google
    // preserve {{ticket.requester.first_name}} through many roundtrips).

    // protectUrls / restoreUrls / makeUrlToken extracted to
    // src/translate-core.js — see destructure at top of this IIFE.

    // Translate one already-split paragraph (no internal \n\n). Tries
    // Google first; if Google throws, falls back to LibreTranslate when
    // configured; if LibreTranslate also throws (or isn't configured),
    // the original Google error propagates up. URLs are tokenized before
    // the backend call so hyperlinks survive whichever provider handles
    // it.
    async function translateParagraph(text, targetLang, sourceLang) {
        const { text: tokenized, urls } = protectUrls(text);
        let translated;

        // While Google is in cool-off, skip it entirely. With LibreTranslate
        // configured we go straight to the fallback for the full 60s window;
        // without it, throw a typed error so the user sees a useful toast
        // ("rate-limited, configure fallback or wait Xs") instead of every
        // call burning another 429.
        if (inGoogleCooloff()) {
            if (!settings.libretranslateUrl) {
                const secs = googleCooloffSecondsLeft();
                throw new Error(`Google Translate rate-limited — wait ${secs}s, or configure LibreTranslate fallback in the popup.`);
            }
            translated = await libreTranslate(tokenized, targetLang, sourceLang);
        } else {
            try {
                translated = await googleTranslate(tokenized, targetLang, sourceLang);
            } catch (googleErr) {
                if (!settings.libretranslateUrl) throw googleErr;
                try {
                    translated = await libreTranslate(tokenized, targetLang, sourceLang);
                } catch (_libreErr) {
                    // Both providers failed. Surface the Google error — it's
                    // usually more informative than LibreTranslate's.
                    throw googleErr;
                }
            }
        }
        const restored = restoreUrls(translated, urls);
        // Since each chunk was already split on \n{2,} before the call,
        // any \n{2,} in the response is translator reformatting (e.g.
        // Google injecting blank lines between numbered list items).
        // Collapse back to single \n so line structure matches the source.
        return restored.replace(/\n{2,}/g, '\n');
    }

    async function translate(text, targetLang = 'en', sourceLang = 'auto') {
        if (!guardExtensionContext()) return text;

        // Unified cache key (no provider prefix) — a translation is a
        // translation regardless of who produced it, and unifying keeps
        // the hit rate higher.
        //
        // The key uses the FULL source text, not a truncated prefix.
        // v1.0.30–v1.0.67 sliced to the first 100 chars, which caused
        // catastrophic collisions: any two messages sharing a 100-char
        // prefix returned the same translation, so a "courier delay"
        // boilerplate cached against one variant served the same
        // German output to every later variant — even when the rest
        // of the message changed completely. Cache version bumped to
        // v6 so the polluted v5 entries are unreachable and evict
        // naturally.
        const memoryKey = `${CACHE_VERSION}:${text}_${targetLang}`;
        cacheStats.total++;
        if (translationMemory[memoryKey]) {
            cacheStats.hits++;
            // LRU bump: JS objects preserve insertion order, so delete +
            // reassign moves this key to the end of the iteration order —
            // i.e. most-recently-used. Oldest key (first in iteration)
            // becomes the eviction candidate on the next miss.
            const cached = translationMemory[memoryKey];
            delete translationMemory[memoryKey];
            translationMemory[memoryKey] = cached;
            persistCacheStats();
            persistMemory();
            ztDbg.log('[zt] Using cached translation (key:', memoryKey.slice(0, 60) + '…)');
            return cached;
        }
        persistCacheStats();

        try {
            // Translate each blank-line-separated paragraph independently
            // so paragraph structure is preserved (Google's public endpoint
            // tends to collapse \n\n to \n in responses). Per-paragraph
            // Google→LibreTranslate fallback handled by translateParagraph.
            const paragraphs = text.split(/\n{2,}/);
            const translatedParagraphs = await Promise.all(
                paragraphs.map(async (p) => {
                    if (!p.trim()) return '';
                    return translateParagraph(p, targetLang, sourceLang);
                })
            );
            const out = translatedParagraphs.join('\n\n');

            if (out) {
                // Evict oldest entries until there's room for the new one.
                // `while` handles the post-migration case where storage was
                // loaded with > CACHE_MAX entries (shouldn't happen, but
                // cheap insurance against a future lowered cap).
                const keys = Object.keys(translationMemory);
                let i = 0;
                while (keys.length - i >= CACHE_MAX) {
                    delete translationMemory[keys[i]];
                    i++;
                }
                translationMemory[memoryKey] = out;
                persistMemory();
            }
            return out || text;
        } catch (err) {
            console.error('[zt] Translation error:', err);
            showToast(readableError(err, 'Translation'), 'error');
            return text;
        }
    }
    
    // ============================================
    // LANGUAGE MAPPING
    // ============================================
    
    const languageInfo = {
        'en': { flag: '🇬🇧', name: 'English' },
        'de': { flag: '🇩🇪', name: 'German' },
        'fr': { flag: '🇫🇷', name: 'French' },
        'es': { flag: '🇪🇸', name: 'Spanish' },
        'it': { flag: '🇮🇹', name: 'Italian' },
        'nl': { flag: '🇳🇱', name: 'Dutch' },
        'pl': { flag: '🇵🇱', name: 'Polish' },
        'pt': { flag: '🇵🇹', name: 'Portuguese' },
        'ru': { flag: '🇷🇺', name: 'Russian' },
        'cs': { flag: '🇨🇿', name: 'Czech' },
        'da': { flag: '🇩🇰', name: 'Danish' },
        'fi': { flag: '🇫🇮', name: 'Finnish' },
        'sv': { flag: '🇸🇪', name: 'Swedish' },
        'no': { flag: '🇳🇴', name: 'Norwegian' },
        'ro': { flag: '🇷🇴', name: 'Romanian' },
        'hu': { flag: '🇭🇺', name: 'Hungarian' },
        'el': { flag: '🇬🇷', name: 'Greek' },
        'bg': { flag: '🇧🇬', name: 'Bulgarian' },
        'sk': { flag: '🇸🇰', name: 'Slovak' },
        'hr': { flag: '🇭🇷', name: 'Croatian' },
        'sl': { flag: '🇸🇮', name: 'Slovenian' },
        'et': { flag: '🇪🇪', name: 'Estonian' },
        'lv': { flag: '🇱🇻', name: 'Latvian' },
        'lt': { flag: '🇱🇹', name: 'Lithuanian' }
    };
    
    function getLanguageDisplay(langCode) {
        const info = languageInfo[langCode] || { flag: '🌐', name: 'Unknown' };
        return `${info.flag} ${info.name}`;
    }
    
    // ============================================
    // UI PROCESSING
    // ============================================

    // Per-comment HTML storage for the toggle between translated and
    // original view. WeakMaps so long message bodies don't bloat the DOM
    // via dataset, and so entries disappear automatically when Zendesk
    // rips the comment element out of the tree (e.g. on ticket switch).
    const commentOriginalHtml = new WeakMap();
    const commentTranslatedHtml = new WeakMap();

    // Canonical agent-vs-customer signal. Inside every message item,
    // Zendesk has <div mode="standalone" type="end-user|agent" data-test-id="omni-log-item-message">.
    // The `type` attribute is the discriminator.
    function isAgentMessage(messageElement) {
        const msg = messageElement.closest('[data-test-id="omni-log-item-message"]');
        if (!msg) return false;
        return msg.getAttribute('type') === 'agent';
    }

    // Split the .zd-comment body into { beforeHtml, afterHtml }. beforeHtml
    // is the customer's new reply (content before the first <blockquote>);
    // afterHtml is the <blockquote> itself plus anything following (quoted
    // email history that was already translated earlier in the ticket).
    // Structure-preserving: wrapping <div>/<p> around the blockquote are
    // kept on both sides so the HTML reconstructs cleanly.
    // splitCommentAtFirstBlockquote and trim helpers extracted to
    // src/translate-core.js.

    async function processCustomerMessage(messageElement) {
        if (messageElement.dataset.ztProcessed) return;
        messageElement.dataset.ztProcessed = 'true';

        const messageBody = messageElement.querySelector('.zd-comment');
        if (!messageBody) return;

        // Skip messages sent by agents (your own team). Inside every
        // message item Zendesk has <div type="end-user|agent"
        // data-test-id="omni-log-item-message">. Agent messages are
        // either already in English or already bilingual (sent via this
        // extension's reply flow) — they don't need translation.
        if (isAgentMessage(messageElement)) return;

        const textContent = (messageBody.innerText || messageBody.textContent).trim();
        if (!textContent || textContent.length < 10) return;

        // Only the customer's new reply (content BEFORE the first
        // <blockquote>) should be translated. The quoted email thread
        // below was already translated earlier in the ticket.
        const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(messageBody);
        const { md: sourceMarkdown, imgs: sourceImgs } = htmlToMarkdownish(beforeHtml);
        if (!sourceMarkdown.trim()) return;  // Nothing to translate (e.g. only a forwarded quote).

        // Per-message detection (v1.0.43 — Phase 1 #6 rolled back).
        //
        // Detection used to short-circuit through a ticket-wide lock
        // populated from the first non-English detection. In practice
        // that often locked the wrong language: short or ambiguous
        // first messages (an order ID, "Hi", an address) detect as the
        // wrong thing, and from then on every message in the ticket
        // was forced through the bad lock. Field reports: English
        // customer replies "translated" to garbled English; a German
        // ticket's reply flag stuck on Finnish.
        //
        // Each customer message now detects independently. The per-
        // message result is cached in `data-zt-lang` so repeat scans
        // (poll tick, ticket switch back) don't burn fresh API calls.
        // The ticket-wide ticketLanguages map is still read by
        // addReplyTranslateButton for *manual* overrides set via the
        // caret dropdown — those remain a deliberate, persistent user
        // action — but auto-detection no longer writes to it.
        let langCode = messageElement.dataset.ztLang;
        if (!langCode) {
            langCode = await detectLanguage(textContent);
            messageElement.dataset.ztLang = langCode;
        }
        if (langCode === 'en') return;

        // Only update the extension-wide detected language from messages
        // the agent is actually looking at. Zendesk keeps other open
        // tickets in the same DOM, and their customer messages would
        // otherwise overwrite detectedCustomerLanguage in a race.
        if (isElementVisible(messageElement)) {
            detectedCustomerLanguage = langCode;
            addReplyTranslateButton();
            updateReplyButton();
        }

        // Stash the original .zd-comment innerHTML so the toggle can
        // restore it after the swap.
        commentOriginalHtml.set(messageBody, messageBody.innerHTML);

        // Render the badge + toggle button row immediately, in a loading
        // state, so the agent sees feedback while the provider call is
        // in flight.
        const translationContainer = document.createElement('div');
        translationContainer.className = 'zt-translate-container';

        const row = document.createElement('div');
        row.className = 'zt-translate-row';

        const badge = document.createElement('div');
        badge.className = 'zt-translate-badge';
        badge.textContent = getLanguageDisplay(langCode);
        row.appendChild(badge);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'zt-translate-btn';
        toggleBtn.textContent = 'Translating…';
        toggleBtn.disabled = true;
        row.appendChild(toggleBtn);

        translationContainer.appendChild(row);
        messageElement.parentNode.insertBefore(translationContainer, messageElement.nextSibling);

        // Fire auto-translate (non-blocking — scan loop continues).
        performAutoTranslate(messageBody, sourceMarkdown, sourceImgs, afterHtml, langCode, badge, toggleBtn);
    }

    // Drive the auto-translate + in-place swap for one customer message.
    // Also wired as the retry handler on failure, so the same function
    // covers both initial run and user-triggered retry.
    async function performAutoTranslate(messageBody, sourceMarkdown, sourceImgs, afterHtml, langCode, badge, toggleBtn) {
        const translatedMarkdown = await translate(sourceMarkdown, 'en', langCode);

        // translate() catches provider errors internally and returns the
        // original text unchanged. Treat identical input/output as failure
        // so we surface a retry button instead of "translating" into the
        // same language. Rare false positives (text that legitimately
        // round-trips to itself) just show a harmless retry button.
        const ok = translatedMarkdown && translatedMarkdown !== sourceMarkdown;

        if (!ok) {
            badge.textContent = getLanguageDisplay(langCode) + ' ⚠';
            badge.title = 'Translation failed';
            toggleBtn.disabled = false;
            toggleBtn.textContent = 'Retry translation';
            toggleBtn.onclick = () => {
                badge.textContent = getLanguageDisplay(langCode);
                badge.title = '';
                toggleBtn.disabled = true;
                toggleBtn.textContent = 'Translating…';
                toggleBtn.onclick = null;
                performAutoTranslate(messageBody, sourceMarkdown, sourceImgs, afterHtml, langCode, badge, toggleBtn);
            };
            return;
        }

        const translatedHtml = markdownishToHtml(translatedMarkdown, sourceImgs);

        // Translated body = label + translated new-reply + quoted history
        // (untouched). The label keeps the "ENGLISH TRANSLATION:" visual
        // cue you asked to keep.
        const translatedBodyHtml =
            '<div class="zt-translation-label">ENGLISH TRANSLATION:</div>' +
            '<div class="zt-translation-body">' + translatedHtml + '</div>' +
            afterHtml;

        commentTranslatedHtml.set(messageBody, translatedBodyHtml);

        // Swap into translated view. Agent sees English by default.
        // Preserve the message's viewport position across the height
        // change — if the agent has already scrolled to read this message
        // when auto-translate finishes, it shouldn't jump under them.
        preserveScrollAround(messageBody, () => {
            messageBody.innerHTML = translatedBodyHtml;
            messageBody.classList.add('zt-showing-translation');
        });

        toggleBtn.disabled = false;
        toggleBtn.textContent = 'Show original';
        toggleBtn.onclick = () => {
            preserveScrollAround(messageBody, () => {
                if (messageBody.classList.contains('zt-showing-translation')) {
                    const original = commentOriginalHtml.get(messageBody);
                    if (original != null) messageBody.innerHTML = original;
                    messageBody.classList.remove('zt-showing-translation');
                    toggleBtn.textContent = 'Show translation';
                } else {
                    const tr = commentTranslatedHtml.get(messageBody);
                    if (tr != null) messageBody.innerHTML = tr;
                    messageBody.classList.add('zt-showing-translation');
                    toggleBtn.textContent = 'Show original';
                }
            });
        };
    }
    
    // ============================================
    // REPLY REPLACEMENT (CKEditor 5 aware)
    // ============================================

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // CKEditor 5 exposes the editor instance on the element with class
    // .ck-editor__editable / .ck-editor__editable_inline (the actual
    // contenteditable root), not on arbitrary wrapper divs. Search the
    // supplied node, then walk up, then look at descendants of the composer
    // subtree and finally the whole document.
    function findCKEditorInstance(startNode) {
        if (startNode && startNode.ckeditorInstance) return startNode.ckeditorInstance;

        let node = startNode ? startNode.parentElement : null;
        while (node && node !== document.body) {
            if (node.ckeditorInstance) return node.ckeditorInstance;
            node = node.parentElement;
        }

        const editableSelectors = [
            '.ck-editor__editable_inline',
            '.ck-editor__editable',
            '[class*="ck-editor__editable"]',
            '.ck-editor'
        ];

        if (startNode) {
            for (const sel of editableSelectors) {
                const match = startNode.querySelector ? startNode.querySelector(sel) : null;
                if (match && match.ckeditorInstance) return match.ckeditorInstance;
            }
        }
        for (const sel of editableSelectors) {
            const nodes = document.querySelectorAll(sel);
            for (const n of nodes) {
                if (n.ckeditorInstance) return n.ckeditorInstance;
            }
        }
        return null;
    }

    // ---- HTML ↔ markdown-ish roundtrip ----
    //
    // Zendesk's composer accepts HTML on paste and serializes rich text as
    // HTML. To preserve formatting through a translation provider we convert
    // the reply to a lightweight markdown representation (which translation
    // engines preserve reliably), translate it as text, then rehydrate to
    // HTML before injection.

    // escapeHtml / serializeNodeAsMarkdown / htmlToMarkdownish /
    // markdownishToHtml / stripMarkdownSyntax extracted to
    // src/translate-core.js (Phase 2 #11). See destructure at the top
    // of this IIFE.

    function contentMatches(replyArea, translatedMarkdown) {
        // Normalize before comparing. Two transforms beyond plain
        // whitespace collapse:
        //
        //   1. Strip `---` separator lines. The markdown encodes the
        //      bilingual separator as `\n\n---\n\n`, but markdownishToHtml
        //      turns it into a real `<hr>` tag that produces zero
        //      innerText. Without this strip, target = "Hallo --- Hello"
        //      vs current = "Hallo Hello" → mismatch on every short
        //      reply (≤40 chars), every strategy reports failure, the
        //      caller sees `ok=false` even though the text visually
        //      landed, and the auto-retranslate `lastEnglish` marker
        //      never advances. Found via v1.0.41 diagnostic logs.
        //
        //   2. Strip `{{ztimgN}}` image tokens (Phase 2 #9). They
        //      rehydrate to `<img>` which has no innerText, same shape
        //      of false-negative as `---`.
        //
        // Both transforms apply to the target side only — current is
        // already post-render so neither artifact is present there.
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const stripInvisibles = (s) => (s || '')
            .replace(/(?:^|\n)---(?=\n|$)/g, '')
            .replace(/\{\{ztimg\d+\}\}/g, '');
        const current = norm(replyArea.innerText || replyArea.textContent);
        const target = norm(stripInvisibles(stripMarkdownSyntax(translatedMarkdown)));
        if (!target) return false;
        if (current === target) return true;
        const head = target.slice(0, Math.min(40, target.length));
        return head.length >= 10 && current.includes(head);
    }

    async function withSpellcheckSuppressed(replyArea, fn) {
        const prev = replyArea.getAttribute('spellcheck');
        replyArea.setAttribute('spellcheck', 'false');
        try {
            return await fn();
        } finally {
            // Restore on next frame so the editor doesn't immediately re-run
            // spellcheck over the just-injected text.
            requestAnimationFrame(() => {
                if (prev === null) replyArea.removeAttribute('spellcheck');
                else replyArea.setAttribute('spellcheck', prev);
            });
        }
    }

    async function tryCKEditorApi(replyArea, plainText, html) {
        const editor = findCKEditorInstance(replyArea);
        if (!editor) return false;
        try {
            if (typeof editor.setData === 'function') {
                editor.setData(html || '');
            } else if (editor.model && typeof editor.model.change === 'function') {
                editor.model.change(writer => {
                    const root = editor.model.document.getRoot();
                    writer.remove(writer.createRangeIn(root));
                    const paragraph = writer.createElement('paragraph');
                    writer.append(paragraph, root);
                    writer.insertText(plainText || '', paragraph, 0);
                });
            } else {
                return false;
            }
            await sleep(80);
            return contentMatches(replyArea, plainText);
        } catch (err) {
            console.warn('[zt] CKEditor API strategy failed:', err);
            return false;
        }
    }

    async function trySyntheticPaste(replyArea, plainText, html) {
        try {
            replyArea.focus();
            await sleep(30);
            document.execCommand('selectAll', false, null);
            await sleep(30);

            const dt = new DataTransfer();
            dt.setData('text/plain', stripMarkdownSyntax(plainText));
            dt.setData('text/html', html);

            const pasteEvent = new ClipboardEvent('paste', {
                clipboardData: dt,
                bubbles: true,
                cancelable: true
            });
            replyArea.dispatchEvent(pasteEvent);
            await sleep(150);
            return contentMatches(replyArea, plainText);
        } catch (err) {
            console.warn('[zt] Synthetic paste strategy failed:', err);
            return false;
        }
    }

    async function replaceReplyText(replyArea, plainText, html) {
        return withSpellcheckSuppressed(replyArea, async () => {
            const strategies = [
                { name: 'ckeditor-api', run: tryCKEditorApi },
                { name: 'synthetic-paste', run: trySyntheticPaste }
            ];
            for (const s of strategies) {
                const ok = await s.run(replyArea, plainText, html);
                if (ok) {
                    ztDbg.log(`[zt] Reply replaced via strategy: ${s.name}`);
                    try {
                        const sel = window.getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(replyArea);
                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    } catch (_) {}
                    return true;
                }
                ztDbg.log(`[zt] Strategy ${s.name} did not stick, trying next`);
            }
            console.error('[zt] All reply replacement strategies failed');
            showToast('Could not replace reply text — no strategy worked.', 'error');
            return false;
        });
    }

    // Zendesk keeps multiple open tickets in the same DOM (only one is
    // visible at a time). Use visibility checks so our button goes into the
    // toolbar the agent is actually looking at, not an off-screen one.
    //
    // Prefer Element.checkVisibility() (Chrome 105+) — it correctly handles
    // display:none, visibility:hidden, content-visibility:hidden, opacity:0
    // on any ancestor. Fall back to offsetParent + bounding rect which only
    // catches display:none reliably.
    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({
                contentVisibilityAuto: true,
                opacityProperty: true,
                visibilityProperty: true
            });
        }
        if (el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    // Find the nearest ancestor of `el` that actually scrolls vertically.
    // Zendesk's conversation log lives inside a custom scrolling div, not
    // the window — adjusting window.scrollY alone would silently no-op
    // there. Returns null when nothing in the chain scrolls (e.g. a short
    // ticket that fits in the viewport), which the caller treats as "use
    // window".
    function findScrollableAncestor(el) {
        let n = el && el.parentElement;
        while (n && n !== document.body && n !== document.documentElement) {
            const cs = getComputedStyle(n);
            if (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) {
                return n;
            }
            n = n.parentElement;
        }
        return null;
    }

    // Run `mutate` (which is expected to change the height of `anchor` —
    // e.g. swap its innerHTML between original and translated content)
    // and then adjust the scroll container so `anchor` stays at the same
    // viewport pixel position. Without this, the Show original ↔ Show
    // translation toggle can shove the message hundreds of pixels under
    // the agent's cursor when source and translation differ in length.
    // Same protection is applied to the initial auto-translate swap so
    // an agent reading a message they've already scrolled to doesn't see
    // it jump when translation lands.
    function preserveScrollAround(anchor, mutate) {
        const scroller = findScrollableAncestor(anchor);
        const before = anchor.getBoundingClientRect().top;
        mutate();
        requestAnimationFrame(() => {
            const after = anchor.getBoundingClientRect().top;
            const delta = after - before;
            if (Math.abs(delta) < 1) return;
            if (scroller) scroller.scrollTop += delta;
            else window.scrollBy(0, delta);
        });
    }

    // Synchronously pick the language of whichever customer message the
    // agent is currently looking at, based on cached detections stored on
    // message elements in data-zt-lang. This is authoritative over the
    // detectedCustomerLanguage global, which can be stale from previous
    // ticket views or from async races during processCustomerMessage.
    function languageOfVisibleTicket() {
        const msgs = document.querySelectorAll('[data-test-id="omni-log-message-content"][data-zt-lang]');
        for (const m of msgs) {
            const l = m.dataset.ztLang;
            if (l && l !== 'en' && l !== 'unknown' && isElementVisible(m)) return l;
        }
        return null;
    }

    // Find our reply-translate button inside the currently-visible ticket's
    // toolbar. Zendesk keeps multiple tickets in the same DOM — walking
    // the visible Enhance toolbar is authoritative, while window.ztReplyButton
    // may point at a button in a hidden ticket from a previous scan.
    function findVisibleReplyButton() {
        const enhance = findVisibleEnhanceButton();
        if (!enhance) return null;
        const toolbar = enhance.closest('[role="toolbar"]');
        if (!toolbar) return null;
        return toolbar.querySelector('.zt-reply-translate-btn');
    }

    function findVisibleEnhanceButton() {
        const buttons = document.querySelectorAll('[aria-label="Enhance writing"]');
        for (const btn of buttons) {
            if (isElementVisible(btn)) return btn;
        }
        return null;
    }

    function findVisibleComposer() {
        const composers = document.querySelectorAll('[contenteditable="true"][data-test-id="omnicomposer-rich-text-ckeditor"]');
        for (const c of composers) {
            if (isElementVisible(c)) return c;
        }
        return null;
    }

    // ============================================
    // REPLY TRANSLATION CORE + AUTO-RETRANSLATE
    // ============================================
    //
    // Phase 1 ended with reply translation triggered only by an explicit
    // flag click. Phase 2 #7 extends that with auto-retranslate: after a
    // first translation lands (so the composer holds <translation> + ---
    // + <english>), an `input` listener watches for edits below the
    // separator and re-runs the translation flow 2s after the agent
    // stops typing. Edits *above* the separator are ignored — that's the
    // agent tweaking the translation itself.

    const AUTO_RETRANSLATE_DEBOUNCE_MS = 2000;

    // Module-level state for auto-retranslate. v1.0.40: removed the
    // per-composer reference — the input listener is now delegated at
    // the document level (see installAutoRetranslateListener) so it
    // survives Zendesk's React re-renders that occasionally swap the
    // composer DOM node between translations.
    const autoRetranslate = {
        timer: null,           // pending debounce timer
        lastEnglish: '',       // last English source we successfully translated
        inProgress: false,     // guard against re-entry / our own injection events
        installed: false,      // document-level listener attached?
    };

    function clearAutoRetranslateState() {
        if (autoRetranslate.timer) {
            clearTimeout(autoRetranslate.timer);
            autoRetranslate.timer = null;
        }
        autoRetranslate.lastEnglish = '';
        autoRetranslate.inProgress = false;
        // Note: we don't tear down the document-level listener here. It
        // self-gates on isEnabled and on the visible composer's content,
        // so re-enabling or switching tickets just resumes naturally.
    }

    // extractEnglishSourceFromMarkdown extracted to src/translate-core.js.

    // v1.0.40: single document-level delegated listener instead of
    // per-composer attachment. Zendesk's React occasionally replaces the
    // composer's contenteditable element wholesale between translations
    // (observed after a synthetic-paste injection on some ticket types),
    // and a listener bound to the previous element silently stops
    // firing. Delegating to `document` and resolving the composer at
    // event time via closest() makes this robust to those re-renders
    // without us needing to track DOM changes ourselves.
    //
    // Idempotent: the `installed` flag means re-calls (init, ticket
    // switch, etc.) leave the existing listener in place. Cost per
    // keystroke is tiny — a closest() call and a quick filter; the
    // expensive work (htmlToMarkdownish, translate) is gated behind the
    // 2s debounce.
    function installAutoRetranslateListener() {
        if (autoRetranslate.installed) return;
        autoRetranslate.installed = true;

        // v1.0.41: unconditional diagnostic logs (prefix [zt-auto]) on
        // every guard so we can see exactly which one is bailing when
        // auto-retranslate fails to fire after a dropdown override. These
        // run regardless of ztDebug — they're cheap, prefixed for easy
        // filtering, and will be quieted in the next release once the
        // root cause is identified.
        const handler = (ev) => {
            if (!isEnabled) return;
            if (autoRetranslate.inProgress) {
                ztDbg.log('[zt-auto] skip: inProgress', { type: ev.type });
                return;
            }
            const composer = ev.target && ev.target.closest
                ? ev.target.closest('[contenteditable="true"][data-test-id="omnicomposer-rich-text-ckeditor"]')
                : null;
            if (!composer) return;  // common: events from outside the composer
            if (!isElementVisible(composer)) {
                ztDbg.log('[zt-auto] skip: composer not visible', { type: ev.type });
                return;
            }
            if (!composer.querySelector('hr')) {
                // No <hr> = no first translation yet, or agent deleted
                // the separator. Quiet because this is the steady state
                // before any reply is translated.
                return;
            }

            const eng = extractEnglishSourceFromMarkdown(htmlToMarkdownish(composer.innerHTML || '').md);
            ztDbg.log('[zt-auto] event', {
                type: ev.type,
                detectedLang: detectedCustomerLanguage,
                eng: eng ? eng.slice(0, 60) : eng,
                lastEnglish: autoRetranslate.lastEnglish ? autoRetranslate.lastEnglish.slice(0, 60) : autoRetranslate.lastEnglish,
                same: eng === autoRetranslate.lastEnglish,
            });
            if (!eng || eng === autoRetranslate.lastEnglish) return;

            if (autoRetranslate.timer) clearTimeout(autoRetranslate.timer);
            autoRetranslate.timer = setTimeout(() => {
                autoRetranslate.timer = null;
                if (autoRetranslate.inProgress) {
                    ztDbg.log('[zt-auto] debounce skip: inProgress');
                    return;
                }
                const live = findVisibleComposer();
                if (!live || !live.isConnected) {
                    ztDbg.log('[zt-auto] debounce skip: composer gone');
                    return;
                }
                if (!live.querySelector('hr')) {
                    ztDbg.log('[zt-auto] debounce skip: no <hr>');
                    return;
                }
                const eng2 = extractEnglishSourceFromMarkdown(htmlToMarkdownish(live.innerHTML || '').md);
                if (!eng2 || eng2 === autoRetranslate.lastEnglish) {
                    ztDbg.log('[zt-auto] debounce skip: eng2 matches lastEnglish', {
                        eng2: eng2 ? eng2.slice(0, 60) : eng2,
                        lastEnglish: autoRetranslate.lastEnglish ? autoRetranslate.lastEnglish.slice(0, 60) : autoRetranslate.lastEnglish,
                    });
                    return;
                }
                ztDbg.log('[zt-auto] FIRE runReplyTranslate', {
                    eng2: eng2.slice(0, 60),
                    targetLang: detectedCustomerLanguage,
                });
                runReplyTranslate(live, findVisibleReplyButton());
            }, AUTO_RETRANSLATE_DEBOUNCE_MS);
        };

        // Capture phase so we beat any inner CKEditor handlers that
        // might stopPropagation. `keyup` is a backup in case `input`
        // fires asynchronously (some IME/composition paths) — the
        // handler is idempotent against duplicate triggers (debounce
        // collapses them).
        document.addEventListener('input', handler, true);
        document.addEventListener('keyup', handler, true);
    }

    // Kept as a thin no-op wrapper so the existing call sites in
    // runReplyTranslate keep their meaning — "we just translated
    // successfully, make sure auto-retranslate is wired up". Now this
    // just installs the global listener if it isn't already.
    function attachAutoRetranslateListener(/* replyArea, triggerBtn */) {
        installAutoRetranslateListener();
    }

    // The single entry point both the click handler and the
    // auto-retranslate debounce funnel through. Assumes preconditions
    // (composer exists, English source non-empty, language detected) —
    // the click handler does its own alert-driven precondition checks
    // before calling here; auto-retranslate's input filter does the
    // equivalent silently.
    async function runReplyTranslate(replyArea, triggerBtn) {
        if (autoRetranslate.inProgress) {
            ztDbg.log('[zt-auto] runReplyTranslate skip: inProgress');
            return false;
        }
        if (!detectedCustomerLanguage) {
            ztDbg.log('[zt-auto] runReplyTranslate skip: no detectedCustomerLanguage');
            return false;
        }

        const replyHtml = replyArea.innerHTML || '';
        const { md: replyMarkdown, imgs: replyImgs } = htmlToMarkdownish(replyHtml);
        const englishSource = extractEnglishSourceFromMarkdown(replyMarkdown);
        if (!englishSource) {
            ztDbg.log('[zt-auto] runReplyTranslate skip: no englishSource');
            return false;
        }
        ztDbg.log('[zt-auto] runReplyTranslate start', { englishSource: englishSource.slice(0, 60), targetLang: detectedCustomerLanguage });

        autoRetranslate.inProgress = true;

        ztDbg.groupCollapsed('[zt debug] reply translation pipeline');
        ztDbg.log('1. reply innerHTML:', replyHtml);
        ztDbg.log('2. reply markdown (full):', JSON.stringify(replyMarkdown));
        ztDbg.log('2a. img tokens captured:', replyImgs.length);
        ztDbg.log('2b. english source:', JSON.stringify(englishSource));

        let originalHTML;
        if (triggerBtn) {
            originalHTML = triggerBtn.innerHTML;
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '⏳';
            triggerBtn.style.cursor = 'wait';
        }

        try {
            const translatedMarkdown = await translate(englishSource, detectedCustomerLanguage, 'en');
            ztDbg.log('3. translated markdown (from provider):', JSON.stringify(translatedMarkdown));

            const combinedMarkdown = `${translatedMarkdown}\n\n---\n\n${englishSource}`;
            // Pass the same imgs array through to the rehydrator so any
            // {{ztimgN}} tokens in either the translation or the English
            // half resolve back to their original <img> outerHTML.
            const combinedHtml = markdownishToHtml(combinedMarkdown, replyImgs);
            ztDbg.log('4. combined HTML (about to inject):', combinedHtml);

            const ok = await replaceReplyText(replyArea, combinedMarkdown, combinedHtml);

            ztDbg.log('5. reply innerHTML after inject:', replyArea.innerHTML);
            ztDbg.log('5b. reply innerText after inject:', replyArea.innerText);
            ztDbg.groupEnd();

            if (ok) {
                autoRetranslate.lastEnglish = englishSource;
                attachAutoRetranslateListener(replyArea, triggerBtn);
            }
            ztDbg.log('[zt-auto] runReplyTranslate end', { ok, lastEnglish: autoRetranslate.lastEnglish.slice(0, 60) });

            if (triggerBtn) {
                triggerBtn.innerHTML = ok ? '✓' : '⚠️';
                triggerBtn.style.cursor = 'pointer';
                triggerBtn.disabled = false;
                setTimeout(() => { triggerBtn.innerHTML = originalHTML; }, 2000);
            }

            return ok;
        } finally {
            autoRetranslate.inProgress = false;
        }
    }

    function addReplyTranslateButton() {
        if (!isEnabled) return;

        // Ground truth precedence (v1.0.39):
        //
        //   1. Ticket-wide lock from chrome.storage.local.ticketLanguages.
        //      This is authoritative when present — set by first detection
        //      OR by an explicit dropdown override. Without checking it
        //      here, the 1.5s polling tick would clobber a freshly-applied
        //      dropdown override by reading the original message's
        //      data-zt-lang and snapping detectedCustomerLanguage back
        //      to the auto-detected language.
        //
        //   2. Visible-ticket message scan (languageOfVisibleTicket) for
        //      the case where no lock has been written yet — the very
        //      first scan tick before processCustomerMessage has run.
        //
        //   3. Existing detectedCustomerLanguage if neither of the above
        //      yields anything (shouldn't happen in steady state, but
        //      avoids tearing down a button mid-render).
        const ticketId = getTicketIdFromUrl();
        const lockedLang = ticketId ? ticketLanguages[ticketId] : null;

        if (lockedLang) {
            if (lockedLang !== detectedCustomerLanguage) {
                detectedCustomerLanguage = lockedLang;
                updateReplyButton();
            }
        } else {
            const visibleLang = languageOfVisibleTicket();
            if (visibleLang) {
                if (visibleLang !== detectedCustomerLanguage) {
                    detectedCustomerLanguage = visibleLang;
                    updateReplyButton();
                }
            } else if (!detectedCustomerLanguage) {
                // No language known yet and none visible — nothing to do this tick.
                return;
            }
        }

        if (!detectedCustomerLanguage || detectedCustomerLanguage === 'en') return;

        const enhanceButton = findVisibleEnhanceButton();
        if (!enhanceButton) return;

        const toolbar = enhanceButton.closest('[role="toolbar"]');
        if (!toolbar) return;

        // Only skip if THIS visible toolbar already has our wrapper. Stale
        // wrappers in hidden ticket tabs (from previous switches) shouldn't
        // prevent us from adding one to the current ticket's toolbar.
        if (toolbar.querySelector('.zt-reply-wrapper')) {
            // Rebind the cached reference in case this wrapper came from a
            // previous scan and the old one got cleaned up.
            window.ztReplyButton = toolbar.querySelector('.zt-reply-translate-btn');
            return;
        }

        const buttonWrapper = document.createElement('div');
        buttonWrapper.className = 'zt-reply-wrapper sc-k83b6s-1 jXsvnN';
        
        const translateBtn = document.createElement('button');
        translateBtn.className = 'zt-reply-translate-btn';
        translateBtn.type = 'button';
        
        updateButtonContent(translateBtn);
        
        translateBtn.style.cssText = `
            background: none;
            border: none;
            cursor: pointer;
            padding: 8px;
            color: #2f3941;
            font-size: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 32px;
            height: 32px;
            border-radius: 4px;
            transition: background-color 0.2s;
        `;
        
        translateBtn.addEventListener('mouseenter', () => {
            translateBtn.style.backgroundColor = '#f5f5f5';
        });
        translateBtn.addEventListener('mouseleave', () => {
            translateBtn.style.backgroundColor = 'transparent';
        });
        
        translateBtn.addEventListener('click', async (e) => {
            e.preventDefault();

            // Click-only preconditions. Surfaced as alerts because they
            // represent user errors the agent needs to acknowledge —
            // toasts would auto-dismiss before they're noticed.
            // Auto-retranslate handles the same conditions silently
            // (the input filter just no-ops).
            if (!detectedCustomerLanguage) {
                alert('No customer language detected. Please translate a customer message first.');
                return;
            }
            const replyArea = findVisibleComposer();
            if (!replyArea) {
                alert('Could not find the active reply area.');
                return;
            }
            const { md: replyMarkdown } = htmlToMarkdownish(replyArea.innerHTML || '');
            if (!replyMarkdown) {
                alert('Please write your reply first.');
                return;
            }
            if (!extractEnglishSourceFromMarkdown(replyMarkdown)) {
                alert('Please write your reply in English below the separator.');
                return;
            }

            await runReplyTranslate(replyArea, translateBtn);
        });

        // Language-override caret (Phase 2 #8). Sits flush right of the
        // flag; click opens a dropdown of all supported languages.
        // Selecting one updates the ticket-wide language lock and, when
        // there's English content, immediately retranslates.
        const caretBtn = document.createElement('button');
        caretBtn.className = 'zt-reply-lang-caret';
        caretBtn.type = 'button';
        // v1.0.38: full-size BLACK DOWN-POINTING TRIANGLE (▼) at 13px+700
        // weight. The previous BLACK DOWN-POINTING SMALL TRIANGLE (▾) at
        // 11px was hard to read against the toolbar background — agents
        // reported mistaking it for screen dust.
        caretBtn.innerHTML = '▼';
        caretBtn.setAttribute('aria-label', 'Change reply language');
        caretBtn.setAttribute('aria-haspopup', 'listbox');
        caretBtn.setAttribute('aria-expanded', 'false');
        caretBtn.title = 'Change reply language';
        caretBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleLanguageMenu(caretBtn);
        });

        buttonWrapper.appendChild(translateBtn);
        buttonWrapper.appendChild(caretBtn);
        toolbar.appendChild(buttonWrapper);

        // Store reference for updates
        window.ztReplyButton = translateBtn;
    }

    // ============================================
    // LANGUAGE-OVERRIDE DROPDOWN (Phase 2 #8)
    // ============================================
    //
    // The caret to the right of the flag opens a fixed-position menu of
    // every supported language. Selecting one writes through to the
    // ticket-wide lock so future messages in this ticket inherit the
    // override automatically. Menu is rebuilt on each open so the active
    // highlight + ticket lock stay in sync. Closes on outside click,
    // Escape, scroll, or a second click of the caret.

    let openLangMenuEl = null;
    let openLangMenuCleanup = null;

    function closeLanguageMenu() {
        if (openLangMenuCleanup) {
            try { openLangMenuCleanup(); } catch (_) {}
            openLangMenuCleanup = null;
        }
        if (openLangMenuEl) {
            openLangMenuEl.remove();
            openLangMenuEl = null;
        }
        // Reset every caret's aria-expanded; there's normally only one
        // visible, but the cleanup is cheap.
        document.querySelectorAll('.zt-reply-lang-caret[aria-expanded="true"]')
            .forEach(b => b.setAttribute('aria-expanded', 'false'));
    }

    function toggleLanguageMenu(caretBtn) {
        if (openLangMenuEl) {
            closeLanguageMenu();
            return;
        }
        openLanguageMenu(caretBtn);
    }

    function openLanguageMenu(caretBtn) {
        const menu = document.createElement('div');
        menu.className = 'zt-reply-lang-menu';
        menu.setAttribute('role', 'listbox');

        // Language list: stable alphabetical order by display name so
        // the agent can scan visually. Static list is fine at this size —
        // see the Phase 2 #8 spec note where we deferred the typeahead
        // search question. v1.0.40: 'en' is filtered out — English is
        // the agent's native language, not a translation target. (The
        // reply flag itself is hidden when detectedCustomerLanguage is
        // 'en' anyway, but a stale flag from a tab-switch race could
        // otherwise show 'en' in the dropdown.)
        const codes = Object.keys(languageInfo)
            .filter(c => c !== 'en')
            .sort((a, b) => languageInfo[a].name.localeCompare(languageInfo[b].name));
        for (const code of codes) {
            const info = languageInfo[code];
            const item = document.createElement('div');
            item.className = 'zt-reply-lang-item';
            if (code === detectedCustomerLanguage) {
                item.classList.add('zt-reply-lang-item-active');
            }
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', code === detectedCustomerLanguage ? 'true' : 'false');
            item.innerHTML =
                `<span class="zt-reply-lang-flag">${info.flag}</span>` +
                `<span>${info.name}</span>`;
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectLanguageOverride(code);
                closeLanguageMenu();
            });
            menu.appendChild(item);
        }

        document.body.appendChild(menu);

        // Position under the caret. Fixed positioning so the menu rides
        // above any Zendesk overflow:hidden wrapper. If the caret is
        // closer to the bottom of the viewport than the top, flip the
        // menu upward so it doesn't get clipped.
        const rect = caretBtn.getBoundingClientRect();
        const menuHeight = Math.min(menu.scrollHeight, 280);
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow >= menuHeight + 8 || spaceBelow >= rect.top) {
            menu.style.top = `${rect.bottom + 4}px`;
        } else {
            menu.style.top = `${Math.max(8, rect.top - menuHeight - 4)}px`;
        }
        // Right-align to the caret so the menu doesn't run off the right
        // edge of the toolbar.
        const desiredLeft = rect.right - 200;
        menu.style.left = `${Math.max(8, desiredLeft)}px`;

        caretBtn.setAttribute('aria-expanded', 'true');
        openLangMenuEl = menu;

        // Dismissal: outside-click and Escape. v1.0.38 redesign:
        //
        //   - Listen on `mousedown` rather than `click`. Item clicks
        //     fire mousedown first, but we let those through via the
        //     geometric check below; the actual selection still runs
        //     on the item's `click` handler.
        //
        //   - Geometric bounding-rect check, not `menu.contains(target)`.
        //     Native scrollbar mousedowns (Chrome) target
        //     document.documentElement, not the scrolling element — so
        //     contains() returns false and the menu would close when the
        //     agent grabs the scrollbar. Comparing event coordinates
        //     against the menu's rect captures the scrollbar area too,
        //     since the rect includes it.
        //
        //   - No `scroll` listener. The previous one closed the menu
        //     whenever the agent scrolled within the menu itself
        //     (capture-phase scroll bubbles up to window), defeating
        //     the scrollbar entirely. Trade-off: scrolling the Zendesk
        //     page with the menu open will leave the (fixed-position)
        //     menu disconnected from the caret. Acceptable — the agent
        //     can click outside or press Escape to close.
        //
        //   - Defer attachment one tick so the click that opened the
        //     menu doesn't immediately close it.
        const onDocMouseDown = (ev) => {
            if (caretBtn.contains(ev.target)) return;  // caret toggle handles itself
            const rect = menu.getBoundingClientRect();
            const x = ev.clientX, y = ev.clientY;
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                return;  // inside the menu (incl. its scrollbar gutter)
            }
            closeLanguageMenu();
        };
        const onKey = (ev) => { if (ev.key === 'Escape') closeLanguageMenu(); };
        const attachId = setTimeout(() => {
            document.addEventListener('mousedown', onDocMouseDown, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);
        openLangMenuCleanup = () => {
            clearTimeout(attachId);
            document.removeEventListener('mousedown', onDocMouseDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }

    async function selectLanguageOverride(code) {
        ztDbg.log('[zt-auto] selectLanguageOverride start', { code, prev: detectedCustomerLanguage });
        // Update the in-memory state and the ticket-wide lock so future
        // messages and reply translations default to the override. Also
        // refresh any open reply buttons so the flag emoji matches.
        detectedCustomerLanguage = code;
        const ticketId = getTicketIdFromUrl();
        if (ticketId && ticketLanguages[ticketId] !== code) {
            ticketLanguages[ticketId] = code;
            persistTicketLanguages();
        }
        updateReplyButton();

        // If the composer has English content below the separator (or no
        // separator yet), immediately translate to the new language. Per
        // the Phase 2 #8 spec: "Selection ... immediately translates this
        // reply." If there's nothing to translate, runReplyTranslate
        // returns false silently and the agent just gets the new flag.
        const replyArea = findVisibleComposer();
        if (!replyArea) return;
        const { md: replyMarkdown } = htmlToMarkdownish(replyArea.innerHTML || '');
        const englishSource = extractEnglishSourceFromMarkdown(replyMarkdown);
        if (!englishSource) return;
        // Reset auto-retranslate's last-translated marker so the new
        // language run isn't filtered out as a no-change repeat of the
        // previous translation.
        autoRetranslate.lastEnglish = '';
        ztDbg.log('[zt-auto] selectLanguageOverride about to runReplyTranslate', { code, englishSource: englishSource.slice(0, 60) });
        await runReplyTranslate(replyArea, findVisibleReplyButton());
        ztDbg.log('[zt-auto] selectLanguageOverride done', { lastEnglish: autoRetranslate.lastEnglish.slice(0, 60), detectedLang: detectedCustomerLanguage });
    }
    
    function updateButtonContent(btn) {
        if (!btn) return;
        
        if (detectedCustomerLanguage) {
            const langInfo = languageInfo[detectedCustomerLanguage] || { flag: '🌐', name: 'Unknown' };
            btn.innerHTML = `<span style="font-size: 20px;">${langInfo.flag}</span>`;
            btn.setAttribute('aria-label', `Translate to ${langInfo.name}`);
            btn.title = `Translate to ${langInfo.name}`;
        } else {
            btn.innerHTML = '🌐';
            btn.setAttribute('aria-label', 'Translate Reply');
            btn.title = 'No language detected yet';
        }
    }
    
    function updateReplyButton() {
        if (window.ztReplyButton) {
            updateButtonContent(window.ztReplyButton);
        }
    }
    
    // ============================================
    // PDF IN-PAGE VIEWER (Phase 3 #12)
    // ============================================
    //
    // Click interception for PDF links inside the conversation log
    // (customer/agent messages and internal notes). Opens Mozilla
    // PDF.js's bundled viewer in a fixed-position modal iframe instead
    // of letting Chrome's default behavior take over (which is usually
    // a download or a fresh tab). The agent stays inside Zendesk while
    // reading the attachment.
    //
    // Scope: links with a `.pdf` URL inside `.zd-comment` only — the
    // user's explicit decision (Phase 3 spec). PDF links elsewhere on
    // the page (e.g. native Zendesk fields, third-party app sidebars
    // like Refurbed 360) keep their default behavior.
    //
    // PDF fetches from *.zdusercontent.com are unblocked by the narrow
    // host-permission grant added to manifest.json in v1.0.45.

    let pdfModal = null;     // currently-open backdrop element
    let pdfPrevFocus = null; // restore focus on close

    function looksLikePdfUrl(href) {
        if (!href || typeof href !== 'string') return false;
        try {
            const u = new URL(href, location.origin);
            // Pathname-based: easy case ("…/foo.pdf").
            if (/\.pdf$/i.test(u.pathname)) return true;
            // Query-based (v1.0.47): Zendesk's own attachment redirector
            // serves PDFs at `/attachments/<token>/?name=Foo.pdf` — the
            // path is opaque, the filename only lives in the `?name=`
            // value. Scan all query values rather than just `name` so
            // we also match other Zendesk URL shapes if any.
            for (const v of u.searchParams.values()) {
                if (/\.pdf$/i.test(v)) return true;
            }
            return false;
        } catch (_) {
            // URL constructor rejects malformed hrefs (relative without
            // a base, etc.). Fall back to a simpler regex.
            return /\.pdf(\?|#|$|[^\w])/i.test(href);
        }
    }

    function isZendeskAttachmentUrl(href) {
        // Zendesk's attachment-serving redirector lives at
        // `https://<subdomain>.zendesk.com/attachments/<token>/...`. A
        // URL of that shape is unambiguously Zendesk's own attachment
        // system — it's never used for navigation links the customer
        // typed into a message — so we can trust the URL pattern alone
        // as a "this is an in-ticket attachment" signal and skip DOM
        // ancestry checks. (v1.0.46's diagnostic showed Zendesk's
        // current attachment markup doesn't sit inside .zd-comment.)
        if (!href) return false;
        try {
            const u = new URL(href, location.origin);
            return /\.zendesk\.com$/i.test(u.hostname)
                && u.pathname.startsWith('/attachments/');
        } catch (_) { return false; }
    }

    function isInsideMessageBody(el) {
        // Fallback DOM scope for non-Zendesk-attachment PDF links —
        // i.e. external PDFs a customer pasted into the message body.
        // Either the legacy `.zd-comment` selector or the modern
        // `[data-test-id="omni-log-message-content"]` covers customer
        // and agent messages plus internal notes.
        if (!(el && el.closest)) return false;
        return !!(el.closest('.zd-comment') || el.closest('[data-test-id="omni-log-message-content"]'));
    }

    async function openPdfModal(pdfUrl) {
        if (pdfModal) closePdfModal();
        pdfPrevFocus = document.activeElement;

        const backdrop = document.createElement('div');
        backdrop.className = 'zt-pdf-backdrop';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');
        backdrop.setAttribute('aria-label', 'PDF viewer');

        // v1.0.51: explicit window wrapper so the iframe sits in the
        // center 2/3 of the viewport (with a sensible max-width cap on
        // ultrawides) and the close button can anchor to the iframe's
        // edge instead of the viewport's. Field feedback was that on a
        // full-screen modal, "the X is too far" — agent's mouse was
        // over the PDF, the close button was at the screen corner.
        const window_ = document.createElement('div');
        window_.className = 'zt-pdf-window';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'zt-pdf-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close PDF viewer');
        closeBtn.title = 'Close (Esc)';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            closePdfModal();
        });

        // Inline status (loading / error). Hidden once the iframe
        // takes over rendering.
        const status = document.createElement('div');
        status.className = 'zt-pdf-status';
        status.textContent = 'Loading PDF…';

        const iframe = document.createElement('iframe');
        iframe.className = 'zt-pdf-frame';
        iframe.setAttribute('title', 'PDF viewer');
        // Open the viewer with NO ?file= query — zt-bridge.js inside
        // the iframe receives the URL via postMessage and tells PDF.js
        // to open it with `withCredentials: true`. The iframe is at
        // chrome-extension:// origin, which is an extension page, so
        // its credentialed fetch uses the user's actual cookie jar for
        // *.zendesk.com (covered by host_permissions). See
        // lib/pdfjs/web/zt-bridge.js for the receive-side.
        const viewerUrl = chrome.runtime.getURL('lib/pdfjs/web/viewer.html');
        iframe.src = viewerUrl;

        // Click on backdrop (not the inner window) dismisses.
        backdrop.addEventListener('mousedown', (ev) => {
            if (ev.target === backdrop) closePdfModal();
        });

        window_.appendChild(iframe);
        window_.appendChild(closeBtn);
        window_.appendChild(status);
        backdrop.appendChild(window_);
        document.body.appendChild(backdrop);
        pdfModal = backdrop;

        // Escape closes. Capture phase so we beat any inner handlers
        // (PDF.js binds its own keyboard shortcuts).
        document.addEventListener('keydown', onPdfKeydown, true);

        // Move focus into the modal so screen readers + keyboard users
        // start there instead of leaving focus on the original link.
        try { closeBtn.focus({ preventScroll: true }); } catch (_) {}

        // v1.0.50 approach: pass the URL string into the iframe and let
        // PDF.js fetch it itself with `withCredentials: true`. The
        // iframe runs at chrome-extension:// origin (an extension page),
        // and extension pages with matching host_permissions can fetch
        // with credentials — Chrome uses the user's actual cookie jar
        // for the target origin (so Zendesk's session cookie travels)
        // and CORS is bypassed.
        //
        // History:
        //   v1.0.48: content script tried to fetch directly. Failed
        //     because in MV3, content-script fetches are cross-origin
        //     from chrome-extension:// and don't get cookies.
        //   v1.0.49: routed through background SW. Fetch worked but
        //     `chrome.runtime.sendMessage` is JSON-only — the
        //     ArrayBuffer arrived as `undefined` on the other side, so
        //     postMessage to the viewer crashed with DataCloneError.
        //   v1.0.50: skip the round-trip entirely. URL → iframe →
        //     PDF.js does the credentialed fetch.
        try {
            await new Promise((resolve) => {
                iframe.addEventListener('load', resolve, { once: true });
            });
            // Iframe may have closed during the load wait (user hit Escape).
            if (!pdfModal || !iframe.contentWindow) return;
            ztDbg.log('[zt-pdf] posting URL to viewer:', pdfUrl);
            iframe.contentWindow.postMessage(
                { type: 'zt-pdf-load', url: pdfUrl },
                '*'
            );
            // Hide status once we've handed off. PDF.js's own progress
            // bar takes over from here. The default sample PDF that
            // briefly auto-loaded gets replaced by `open({url, ...})`
            // — short visual flash, acceptable trade-off vs. the
            // alternatives (which all turned out to be worse, see
            // history above).
            status.style.display = 'none';
        } catch (err) {
            console.error('[zt-pdf] postMessage failed:', err);
            status.textContent = `Failed to load PDF: ${err.message || err}`;
            status.classList.add('zt-pdf-status-error');
        }
    }

    function onPdfKeydown(ev) {
        if (ev.key === 'Escape' && pdfModal) {
            ev.preventDefault();
            ev.stopPropagation();
            closePdfModal();
        }
    }

    function closePdfModal() {
        if (!pdfModal) return;
        document.removeEventListener('keydown', onPdfKeydown, true);
        pdfModal.remove();
        pdfModal = null;
        if (pdfPrevFocus && typeof pdfPrevFocus.focus === 'function') {
            try { pdfPrevFocus.focus({ preventScroll: true }); } catch (_) {}
        }
        pdfPrevFocus = null;
    }

    function installPdfClickInterceptor() {
        if (window.__ztPdfInterceptorInstalled) return;
        window.__ztPdfInterceptorInstalled = true;

        // v1.0.46 diagnostic: log every click on an anchor so we can see
        // why PDF clicks aren't being intercepted in the field. Logs go
        // out unconditionally (no ztDebug gate) for one release; will be
        // either removed or moved under ztDbg.log once the root cause
        // is known. Filter by `[zt-pdf]` in DevTools.
        //
        // Capture phase so we beat Zendesk's own click handlers and any
        // navigation-style listeners on the link itself.
        document.addEventListener('click', (ev) => {
            if (!isEnabled) return;
            if (ev.button !== 0) return;
            if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

            const target = ev.target;
            const anchor = target && target.closest
                ? target.closest('a[href]')
                : null;

            // Only log when we have an anchor — bare clicks on text /
            // chrome are too noisy to log.
            if (!anchor) return;

            const looksLikePdf = looksLikePdfUrl(anchor.href);
            const isZdAttachment = isZendeskAttachmentUrl(anchor.href);
            const inMessage = isInsideMessageBody(anchor);

            ztDbg.log('[zt-pdf] anchor click', {
                href: anchor.href,
                target: anchor.getAttribute('target'),
                download: anchor.hasAttribute('download'),
                looksLikePdf,
                isZdAttachment,
                inMessage,
                clickTargetTag: target && target.tagName,
                anchorTestId: anchor.getAttribute('data-test-id'),
                ancestorTestIds: collectAncestorTestIds(anchor),
            });

            if (!looksLikePdf) return;

            // Two acceptable trigger paths (v1.0.47):
            //   A. Zendesk's own attachment URL pattern. Trusted by URL
            //      alone; DOM ancestry doesn't matter because the
            //      `/attachments/<token>/` endpoint is exclusive to
            //      Zendesk's attachment system.
            //   B. External PDF URL inside a message body — covers the
            //      rare case of a customer/agent pasting a public PDF
            //      link into a message. Still gated on the DOM scope
            //      check so PDF links elsewhere on the page (sidebar
            //      apps, native fields) keep their default behavior.
            if (!isZdAttachment && !inMessage) {
                ztDbg.log('[zt-pdf] skip: not a Zendesk attachment and not in a message body');
                return;
            }

            ztDbg.log('[zt-pdf] intercepting and opening modal');
            ev.preventDefault();
            ev.stopPropagation();
            openPdfModal(anchor.href);
        }, true);
    }

    // Tiny helper: walk up the anchor's ancestors and collect every
    // data-test-id we find, up to 8 levels. Helps identify whatever
    // wrapper Zendesk is using for attachments in current builds.
    function collectAncestorTestIds(el) {
        const ids = [];
        let n = el && el.parentElement;
        let depth = 0;
        while (n && depth < 8) {
            const id = n.getAttribute && n.getAttribute('data-test-id');
            if (id) ids.push(id);
            n = n.parentElement;
            depth++;
        }
        return ids;
    }

    // ============================================
    // MACRO AUTOCOMPLETE (Phase 4 #13)
    // ============================================
    //
    // Trigger: agent types `//partial` in the composer; we show a
    // dropdown filtered by substring match against the saved macro
    // names; agent picks one with arrow-keys+Enter or click; we replace
    // the `//partial` fragment with the macro body via the same
    // synthetic-paste pipeline reply translation uses (so CKEditor
    // accepts the HTML and the formatting roundtrips correctly).
    //
    // Macros live at chrome.storage.local.macros (managed via the
    // settings page at macros.html, opened from the popup). Storage
    // shape:
    //   { "<name>": { body: "<html>", attachments: [], updated: <ts> } }
    //
    // Placeholders like {{ticket.requester.first_name}} pass through
    // verbatim — we don't resolve them; Zendesk substitutes at send
    // time.

    // Module-level cache of macros, kept in sync via storage.onChanged
    // so the autocomplete picks up edits made in another tab without
    // requiring the agent to refresh Zendesk.
    let macros = {};

    function loadMacrosFromStorage() {
        chrome.storage.local.get(['macros'], (r) => {
            if (r && r.macros && typeof r.macros === 'object') {
                macros = r.macros;
            }
            console.log('[zt-macro] loaded from storage:', Object.keys(macros).length, 'macros:', Object.keys(macros));
        });
    }

    // -----------------------------
    // Trigger detection
    // -----------------------------

    // Module-level state for the open dropdown. Only one composer is
    // visible at a time so a single object suffices (same pattern as
    // autoRetranslate / openLangMenuEl).
    const macroAutocomplete = {
        menu: null,            // dropdown element when open
        composer: null,        // composer the dropdown is anchored to
        partial: '',           // current `partial` text (after the //)
        partialStart: null,    // { node, offset } where the // begins
        items: [],             // filtered macro names currently displayed
        activeIndex: 0,        // arrow-key cursor
        cleanup: null,         // listener teardown function
    };

    function isMacroNameChar(ch) {
        return /[A-Za-z0-9_-]/.test(ch);
    }

    // Walk back from the current selection caret looking for `//` and
    // return { partial, range } if we find a valid trigger fragment in
    // the same text node. Returns null otherwise (no //, // is mid-URL,
    // partial contains a non-name char, etc).
    function findMacroTriggerAtCaret(composer) {
        const sel = composer.ownerDocument.getSelection();
        if (!sel || sel.rangeCount === 0) {
            ztDbg.log('[zt-macro] trigger skip: no selection');
            return null;
        }
        const range = sel.getRangeAt(0);
        if (!range.collapsed) {
            ztDbg.log('[zt-macro] trigger skip: range not collapsed');
            return null;
        }
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE) {
            ztDbg.log('[zt-macro] trigger skip: caret not in text node, nodeType=', node.nodeType, 'tagName=', node.tagName);
            return null;
        }
        const offset = range.startOffset;
        const text = node.data || '';
        ztDbg.log('[zt-macro] trigger inspect: text=', JSON.stringify(text), 'offset=', offset);

        // Walk back from the caret. Accept name chars; stop at `/`,
        // whitespace, or other punctuation. The `//` must be immediately
        // before the partial (or at the beginning of the partial if
        // empty).
        let i = offset;
        while (i > 0 && isMacroNameChar(text.charAt(i - 1))) i--;
        // i now points to the start of the partial (or to the offset
        // itself if the caret sits right after `//`).
        if (i < 2) {
            ztDbg.log('[zt-macro] trigger skip: i<2 after walkback, i=', i);
            return null;
        }
        if (text.charAt(i - 1) !== '/' || text.charAt(i - 2) !== '/') {
            ztDbg.log('[zt-macro] trigger skip: no // before partial. text[i-2..i]=', JSON.stringify(text.slice(i - 2, i)));
            return null;
        }

        // Make sure `//` isn't part of a URL or other glued sequence —
        // require either start of node, or a whitespace/punctuation
        // boundary, immediately before the `//`. (Catches things like
        // `https://foo` or `path//bar` not being treated as triggers.)
        if (i - 2 > 0) {
            const before = text.charAt(i - 3);
            if (!/[\s(\[{>]/.test(before)) {
                ztDbg.log('[zt-macro] trigger skip: glued before //, char=', JSON.stringify(before));
                return null;
            }
        }

        const partial = text.slice(i, offset);
        const triggerStart = i - 2;  // the position of the first `/`
        const triggerRange = composer.ownerDocument.createRange();
        triggerRange.setStart(node, triggerStart);
        triggerRange.setEnd(node, offset);
        ztDbg.log('[zt-macro] trigger MATCH: partial=', JSON.stringify(partial));
        return { partial, range: triggerRange };
    }

    // -----------------------------
    // Dropdown UI
    // -----------------------------

    function closeMacroMenu() {
        if (macroAutocomplete.cleanup) {
            try { macroAutocomplete.cleanup(); } catch (_) {}
            macroAutocomplete.cleanup = null;
        }
        if (macroAutocomplete.menu) {
            macroAutocomplete.menu.remove();
            macroAutocomplete.menu = null;
        }
        macroAutocomplete.composer = null;
        macroAutocomplete.partial = '';
        macroAutocomplete.partialStart = null;
        macroAutocomplete.items = [];
        macroAutocomplete.activeIndex = 0;
    }

    function filterMacrosByPartial(partial) {
        const all = Object.keys(macros);
        if (!partial) return all.sort((a, b) => a.localeCompare(b));
        const needle = partial.toLowerCase();
        return all
            .filter(n => n.toLowerCase().includes(needle))
            .sort((a, b) => {
                // Prefix matches first, then alphabetical.
                const aPrefix = a.toLowerCase().startsWith(needle);
                const bPrefix = b.toLowerCase().startsWith(needle);
                if (aPrefix && !bPrefix) return -1;
                if (!aPrefix && bPrefix) return 1;
                return a.localeCompare(b);
            });
    }

    function renderMacroMenu() {
        const menu = macroAutocomplete.menu;
        if (!menu) return;
        menu.innerHTML = '';
        const items = macroAutocomplete.items;
        ztDbg.log('[zt-macro] rendering menu with', items.length, 'items:', items);
        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'zt-macro-menu-empty';
            empty.textContent = macroAutocomplete.partial
                ? `No macros match "${macroAutocomplete.partial}".`
                : 'No macros yet — open the popup → Manage macros.';
            menu.appendChild(empty);
            return;
        }
        items.forEach((name, idx) => {
            const item = document.createElement('div');
            item.className = 'zt-macro-menu-item';
            if (idx === macroAutocomplete.activeIndex) item.classList.add('zt-macro-menu-item-active');
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', idx === macroAutocomplete.activeIndex ? 'true' : 'false');

            const slash = document.createElement('span');
            slash.className = 'zt-macro-menu-slash';
            slash.textContent = '//';
            item.appendChild(slash);

            const label = document.createElement('span');
            label.className = 'zt-macro-menu-name';
            label.textContent = name;
            item.appendChild(label);

            item.addEventListener('mousedown', (ev) => {
                // mousedown not click: composer would lose focus on
                // click, collapsing the saved selection range. We
                // commit the insertion synchronously here.
                ev.preventDefault();
                ev.stopPropagation();
                macroAutocomplete.activeIndex = idx;
                commitSelectedMacro();
            });
            menu.appendChild(item);
        });
    }

    function positionMacroMenu(triggerRange) {
        const menu = macroAutocomplete.menu;
        if (!menu || !triggerRange) return;
        const rect = triggerRange.getBoundingClientRect();
        ztDbg.log('[zt-macro] positioning menu, trigger rect=', {
            top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right,
            width: rect.width, height: rect.height,
        });
        // Anchor below the // by default; flip above if too close to
        // viewport bottom.
        const menuHeight = Math.min(menu.scrollHeight || 240, 240);
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow >= menuHeight + 8 || spaceBelow >= rect.top) {
            menu.style.top = `${rect.bottom + 4}px`;
        } else {
            menu.style.top = `${Math.max(8, rect.top - menuHeight - 4)}px`;
        }
        // Left-align the menu with the //. Clamp to viewport.
        const desiredLeft = rect.left;
        const maxLeft = window.innerWidth - 280 - 8;
        menu.style.left = `${Math.max(8, Math.min(desiredLeft, maxLeft))}px`;
    }

    function openOrUpdateMacroMenu(composer, trigger) {
        macroAutocomplete.composer = composer;
        macroAutocomplete.partial = trigger.partial;
        macroAutocomplete.partialStart = {
            node: trigger.range.startContainer,
            offset: trigger.range.startOffset,
        };
        macroAutocomplete.items = filterMacrosByPartial(trigger.partial);
        macroAutocomplete.activeIndex = Math.min(
            macroAutocomplete.activeIndex,
            Math.max(0, macroAutocomplete.items.length - 1)
        );

        if (!macroAutocomplete.menu) {
            const menu = document.createElement('div');
            menu.className = 'zt-macro-menu';
            menu.setAttribute('role', 'listbox');
            menu.setAttribute('aria-label', 'Macro suggestions');
            document.body.appendChild(menu);
            macroAutocomplete.menu = menu;

            // Dismissal listeners: outside-click + Escape (handled by
            // the keydown capture listener below, which also drives
            // arrow-keys + Enter).
            const onDocMouseDown = (ev) => {
                if (!macroAutocomplete.menu) return;
                if (macroAutocomplete.menu.contains(ev.target)) return;
                if (composer.contains(ev.target)) return;  // typing in composer keeps it open
                closeMacroMenu();
            };
            document.addEventListener('mousedown', onDocMouseDown, true);
            macroAutocomplete.cleanup = () => {
                document.removeEventListener('mousedown', onDocMouseDown, true);
            };
        }

        renderMacroMenu();
        positionMacroMenu(trigger.range);
    }

    function moveMacroSelection(delta) {
        if (!macroAutocomplete.menu) return;
        const len = macroAutocomplete.items.length;
        if (len === 0) return;
        macroAutocomplete.activeIndex = (macroAutocomplete.activeIndex + delta + len) % len;
        renderMacroMenu();
        // Keep the active item in view.
        const active = macroAutocomplete.menu.querySelector('.zt-macro-menu-item-active');
        if (active && active.scrollIntoView) {
            active.scrollIntoView({ block: 'nearest' });
        }
    }

    // -----------------------------
    // Insertion
    // -----------------------------

    // The macros editor encodes visible blank lines as `<div><br></div>`
    // (or `<p><br></p>`) — the user types Enter twice and the editor
    // inserts an empty block. But CKEditor 5's paste pipeline filters
    // out truly-empty block elements, so those sentinels disappear and
    // the agent sees a wall of text without the gaps they authored.
    //
    // Fix: rewrite any empty / br-only / nbsp-only block element into
    // `<p>&nbsp;</p>`. The non-breaking space gives the paragraph
    // non-empty content that survives the paste filter, and CKEditor
    // renders it as a visible blank line — matching what the agent saw
    // in the macros editor.
    function normalizeMacroHtmlForInsertion(html) {
        if (!html) return '';

        // Text-level regex replacement of blank block elements. Earlier
        // attempts walked the DOM and inspected `el.innerHTML`, but for
        // reasons we couldn't pin down (browser-specific serialization?
        // hidden whitespace? overzealous parser fixup?) the empty
        // `<div><br></div>` blocks were never matching. Regex on the
        // raw HTML string is faster and isn't subject to those quirks.
        //
        // Match: <div> or <p> (any attrs) containing only any combo of
        // whitespace, <br> (any attrs), &nbsp; entities, or literal
        // U+00A0 chars. Replace with a CKEditor-friendly sentinel: a
        // <p> with a literal NBSP text content. The NBSP is a real text
        // character in the model (not a CSS rule, not a filler attr),
        // so CKEditor 5's paste pipeline can't strip it as "empty".
        const blankBlockRegex = /<(div|p)\b[^>]*>(?:\s|<br\b[^>]*\/?>|&nbsp;|\u00A0)*<\/\1>/gi;
        let blanksReplaced = 0;
        const result = html.replace(blankBlockRegex, () => {
            blanksReplaced++;
            return '<p>\u00A0</p>';
        });

        ztDbg.log('[zt-macro] normalize: input', html.length, 'chars; output', result.length, 'chars; blanks replaced=', blanksReplaced);
        return result;
    }

    function commitSelectedMacro() {
        const name = macroAutocomplete.items[macroAutocomplete.activeIndex];
        const composer = macroAutocomplete.composer;
        const startInfo = macroAutocomplete.partialStart;
        if (!name || !composer || !startInfo) {
            closeMacroMenu();
            return;
        }
        const macro = macros[name];
        if (!macro || !macro.body) {
            closeMacroMenu();
            return;
        }

        // Reconstruct the trigger range from the saved start position +
        // current caret. The caret may have moved if the user typed more
        // since the dropdown opened.
        const sel = composer.ownerDocument.getSelection();
        if (!sel || sel.rangeCount === 0) {
            closeMacroMenu();
            return;
        }
        const caretRange = sel.getRangeAt(0);
        const replaceRange = composer.ownerDocument.createRange();
        try {
            replaceRange.setStart(startInfo.node, startInfo.offset);
            replaceRange.setEnd(caretRange.startContainer, caretRange.startOffset);
        } catch (err) {
            console.warn('[zt-macro] could not build replace range:', err);
            closeMacroMenu();
            return;
        }

        const normalizedBody = normalizeMacroHtmlForInsertion(macro.body);
        ztDbg.log('[zt-macro] commit start, name=', name, 'bodyLen=', normalizedBody.length);

        // Strategy:
        //   1. Set the DOM selection to cover the `//partial` trigger.
        //   2. Defer the synthetic paste to the next event-loop tick.
        //
        // CKEditor 5's SelectionObserver syncs its model selection from
        // the DOM only on async `selectionchange` events. Earlier
        // versions did synchronous DOM surgery to remove the `//` first
        // — but CKEditor's MutationObserver reverted the deletion (its
        // model still had `//`), so the paste landed AFTER the restored
        // `//` and the trigger persisted.
        //
        // The setTimeout(0) delay gives CKEditor's selection observer
        // a chance to sync the model selection. When the paste fires,
        // its clipboard plugin sees a non-collapsed model selection
        // covering `//`, deletes that, and inserts the macro in its
        // place — atomically.
        sel.removeAllRanges();
        sel.addRange(replaceRange);
        ztDbg.log('[zt-macro] selection set, range text=', JSON.stringify(replaceRange.toString()));

        // Snapshot composer state for post-mortem.
        const beforeHtml = composer.innerHTML;

        setTimeout(() => {
            try {
                const dt = new DataTransfer();
                dt.setData('text/plain', textOnly(normalizedBody));
                dt.setData('text/html', normalizedBody);
                const pasteEvent = new ClipboardEvent('paste', {
                    clipboardData: dt,
                    bubbles: true,
                    cancelable: true,
                });
                const dispatched = composer.dispatchEvent(pasteEvent);
                ztDbg.log('[zt-macro] paste dispatched, defaultPrevented=', pasteEvent.defaultPrevented, 'returned=', dispatched);

                // Dump the composer HTML 100ms after paste so we can see
                // what CKEditor actually produced — useful for diagnosing
                // both trigger persistence and paragraph-spacing issues.
                setTimeout(() => {
                    const afterHtml = composer.innerHTML;
                    ztDbg.log('[zt-macro] composer.innerHTML BEFORE paste:', beforeHtml.slice(0, 400));
                    ztDbg.log('[zt-macro] composer.innerHTML AFTER  paste:', afterHtml.slice(0, 800));
                    ztDbg.log('[zt-macro] inserted body was:', normalizedBody.slice(0, 400));
                }, 100);

                // After the body has settled, dispatch the attachment
                // drop. Even if attachMacroFiles is async we don't await
                // — the composer is already populated, and a slow
                // attachment chain shouldn't block the rest of the
                // commit cleanup.
                if (macro.attachments && macro.attachments.length > 0) {
                    attachMacroFiles(composer, macro.attachments).catch((err) => {
                        console.error('[zt-macro] attachMacroFiles failed:', err);
                    });
                }
            } catch (err) {
                console.error('[zt-macro] paste dispatch failed:', err);
                try {
                    const ok = composer.ownerDocument.execCommand('insertHTML', false, normalizedBody);
                    ztDbg.log('[zt-macro] execCommand insertHTML fallback returned=', ok);
                } catch (e2) {
                    console.error('[zt-macro] execCommand fallback also failed:', e2);
                }
            }
        }, 0);

        closeMacroMenu();
    }

    function textOnly(html) {
        // Strip tags for the text/plain payload — used as a fallback by
        // pasters that don't honor text/html. Good enough for the
        // synthetic paste; CKEditor uses text/html when available.
        const tmp = document.createElement('div');
        tmp.innerHTML = html || '';
        return (tmp.innerText || tmp.textContent || '').trim();
    }

    // -----------------------------
    // Macro attachment dispatch (Phase 4 #15)
    // -----------------------------
    //
    // After the macro body is pasted into the reply composer, look up
    // any PDF attachments stored against the macro and inject them
    // into the reply via a synthetic drop event. Zendesk's Lotus reply
    // form treats files dropped onto the composer area the same as a
    // user drag-drop, routing them through its normal upload pipeline
    // and showing them as attachment chips below the body.
    //
    // Storage: blobs are kept as base64 in
    //   chrome.storage.local.macroAttachments = { <id>: <base64> }
    // (See macros.js — Phase A wrote this code.) We read on-demand
    // rather than caching all attachments in memory because a team
    // can easily end up with tens of MB of canned PDFs.

    function loadAttachmentBlobs(ids) {
        return new Promise((resolve) => {
            chrome.storage.local.get(['macroAttachments'], (r) => {
                const index = (r && r.macroAttachments) || {};
                resolve(ids.map(id => ({ id, base64: index[id] || null })));
            });
        });
    }

    function base64ToBlob(base64, mimeType) {
        // Standard base64 → Uint8Array → Blob round trip. atob/btoa
        // are byte-oriented; for binary data this is exactly right.
        const bin = atob((base64 || '').replace(/\s+/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mimeType || 'application/pdf' });
    }

    // Walk up from the composer looking for a file input descendant
    // anywhere in an ancestor's subtree. The reply form's hidden file
    // input is what the "Attach" button drives; setting `.files` on it
    // and firing `change` is the React-friendly upload path.
    function findReplyFileInput(composer) {
        let el = composer;
        while (el && el !== document.body) {
            // Prefer one that explicitly accepts PDFs / has an
            // attachment-ish test id.
            const specific = el.querySelector(
                'input[type="file"][accept*="pdf"], ' +
                'input[type="file"][data-test-id*="attach" i], ' +
                'input[type="file"][data-test-id*="upload" i]'
            );
            if (specific) return specific;
            el = el.parentElement;
        }
        // Last-resort: any file input anywhere on the page that's not a
        // chat / messaging widget (those tend to live in iframes anyway).
        return document.querySelector('input[type="file"]');
    }

    async function attachMacroFiles(composer, attachments) {
        if (!attachments || attachments.length === 0) return;
        ztDbg.log('[zt-macro] attaching', attachments.length, 'file(s) to composer');

        const blobs = await loadAttachmentBlobs(attachments.map(a => a.id));
        const dataTransfer = new DataTransfer();
        let attached = 0;

        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const slot = blobs[i];
            if (!slot || !slot.base64) {
                console.warn('[zt-macro] attachment blob missing for', att.id, '(', att.name, ')');
                continue;
            }
            try {
                const blob = base64ToBlob(slot.base64, att.type);
                const file = new File([blob], att.name, {
                    type: att.type || 'application/pdf',
                    lastModified: Date.now(),
                });
                dataTransfer.items.add(file);
                attached++;
            } catch (err) {
                console.error('[zt-macro] failed to materialize attachment', att.name, err);
            }
        }

        if (attached === 0) {
            console.warn('[zt-macro] no attachments materialized; skipping upload');
            return;
        }

        // Strategy 1: file-input upload. Find Zendesk's hidden file
        // input (the one wired up to the "Attach" button), set
        // `.files = dataTransfer.files`, dispatch `change`. This is
        // exactly what a real user click on the file picker produces,
        // so React/Lotus state updates correctly and no drag-drop
        // overlay is involved.
        const fileInput = findReplyFileInput(composer);
        if (fileInput) {
            try {
                fileInput.files = dataTransfer.files;
                fileInput.dispatchEvent(new Event('input', { bubbles: true }));
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                ztDbg.log('[zt-macro] uploaded via file input:',
                    fileInput.dataset && fileInput.dataset.testId
                        ? `[data-test-id="${fileInput.dataset.testId}"]`
                        : (fileInput.className || '(unnamed)'));
                return;
            } catch (err) {
                console.warn('[zt-macro] file-input upload failed, falling back to drop:', err);
            }
        } else {
            console.warn('[zt-macro] no file input found; falling back to drop');
        }

        // Strategy 2 (fallback): synthetic drop on document.body.
        // Crucially we do NOT fire dragenter/dragover — Zendesk has a
        // global dragenter listener that pops up a "Drop to Attach"
        // overlay, and if our drop isn't aimed at the overlay's own
        // drop zone the overlay gets stuck. Drop alone keeps the UI
        // quiet; if there's a global drop handler somewhere it'll
        // catch this through normal bubbling.
        try {
            const dropEvt = new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                composed: true,
                dataTransfer,
            });
            const ok = document.body.dispatchEvent(dropEvt);
            ztDbg.log('[zt-macro] fallback drop on document.body: defaultPrevented=',
                dropEvt.defaultPrevented, 'returned=', ok);
            // Defensive cleanup in case any listener got into a stuck
            // drag state earlier — fire dragleave/dragend so any
            // stray "Drop to Attach" overlays dismiss.
            document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
            document.body.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        } catch (err) {
            console.error('[zt-macro] fallback drop dispatch failed:', err);
        }
    }

    // -----------------------------
    // Document-level listeners
    // -----------------------------

    function installMacroAutocomplete() {
        if (window.__ztMacroAutocompleteInstalled) return;
        window.__ztMacroAutocompleteInstalled = true;

        // Shared trigger-evaluation: locate the active composer (either
        // from the event target or by walking up from the caret) and
        // either open / update / close the menu accordingly. Used by
        // multiple listeners since CKEditor's beforeinput / input events
        // don't always fire when we'd expect (e.g. backspace).
        const reevaluateTrigger = (eventTarget) => {
            if (!isEnabled) { closeMacroMenu(); return; }
            let composer = null;
            if (eventTarget && eventTarget.closest) {
                composer = eventTarget.closest('[contenteditable="true"][data-test-id="omnicomposer-rich-text-ckeditor"]');
            }
            if (!composer) {
                // Fall back to the focused element / caret container.
                const sel = document.getSelection && document.getSelection();
                if (sel && sel.rangeCount > 0) {
                    let node = sel.getRangeAt(0).startContainer;
                    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
                    if (node && node.closest) {
                        composer = node.closest('[contenteditable="true"][data-test-id="omnicomposer-rich-text-ckeditor"]');
                    }
                }
            }
            if (!composer) {
                closeMacroMenu();
                return;
            }
            if (!isElementVisible(composer)) {
                closeMacroMenu();
                return;
            }
            const trigger = findMacroTriggerAtCaret(composer);
            if (!trigger) {
                closeMacroMenu();
                return;
            }
            openOrUpdateMacroMenu(composer, trigger);
        };

        // Recompute trigger on every input. Cheap: a single Selection
        // walk over the text node containing the caret.
        const onInput = (ev) => {
            ztDbg.log('[zt-macro] input event, type=', ev.type, 'inputType=', ev.inputType);
            reevaluateTrigger(ev.target);
        };
        document.addEventListener('input', onInput, true);

        // Backstop for cases where CKEditor swallows the input event
        // (notably backspace inside an empty paragraph). selectionchange
        // fires on every caret movement, so it will catch the case
        // where the user deletes `//` and the menu should close.
        const onSelectionChange = () => {
            if (!macroAutocomplete.menu) return;  // only relevant when menu is open
            // Use the existing composer if known; otherwise fall back to
            // the caret node lookup inside reevaluateTrigger.
            reevaluateTrigger(macroAutocomplete.composer);
        };
        document.addEventListener('selectionchange', onSelectionChange, true);

        // Additional fallback: keyup catches deletions that don't
        // produce input events (Backspace at start of block in some
        // CKEditor versions).
        const onKeyUp = (ev) => {
            if (ev.key === 'Backspace' || ev.key === 'Delete') {
                reevaluateTrigger(ev.target);
            }
        };
        document.addEventListener('keyup', onKeyUp, true);

        // Keyboard navigation. Capture phase so we beat CKEditor's own
        // handlers (which would otherwise eat ArrowDown / Enter).
        const onKeyDown = (ev) => {
            if (!macroAutocomplete.menu) return;
            switch (ev.key) {
                case 'ArrowDown':
                    ev.preventDefault();
                    ev.stopPropagation();
                    moveMacroSelection(1);
                    break;
                case 'ArrowUp':
                    ev.preventDefault();
                    ev.stopPropagation();
                    moveMacroSelection(-1);
                    break;
                case 'Enter':
                case 'Tab':
                    if (macroAutocomplete.items.length === 0) {
                        closeMacroMenu();
                        return;
                    }
                    ev.preventDefault();
                    ev.stopPropagation();
                    commitSelectedMacro();
                    break;
                case 'Escape':
                    ev.preventDefault();
                    ev.stopPropagation();
                    closeMacroMenu();
                    break;
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
    }

    // ============================================
    // INITIALIZATION
    // ============================================

    let mainObserver = null;
    let pollTimer = null;
    let currentTicketId = null;

    function getTicketIdFromUrl() {
        const m = location.pathname.match(/\/agent\/tickets\/(\d+)/);
        return m ? m[1] : null;
    }

    function resetTicketState() {
        detectedCustomerLanguage = null;
        restoreSwappedComments();
        document.querySelectorAll('.zt-translate-container, .zt-translate-row, .zt-translate-badge, .zt-translate-btn, .zt-translation-result, .zt-reply-wrapper, .zt-reply-translate-btn').forEach(el => el.remove());
        document.querySelectorAll('[data-zt-processed]').forEach(el => {
            delete el.dataset.ztProcessed;
        });
        window.ztReplyButton = null;
        // Clear any pending auto-retranslate debounce — its composer
        // belonged to the previous ticket and may now be detached.
        clearAutoRetranslateState();
        // Drop any open language-override menu — its anchor button was
        // just removed.
        closeLanguageMenu();
        // Drop any open macro autocomplete dropdown for the same reason.
        closeMacroMenu();
    }

    // Before removing UI, put back the original .zd-comment contents for
    // any message we swapped. Otherwise Zendesk is left with our translated
    // HTML in its DOM — visible to the agent and also cached if Zendesk
    // re-renders.
    function restoreSwappedComments() {
        document.querySelectorAll('.zd-comment.zt-showing-translation').forEach(body => {
            const original = commentOriginalHtml.get(body);
            if (original != null) body.innerHTML = original;
            body.classList.remove('zt-showing-translation');
        });
    }

    function checkTicketChange() {
        const t = getTicketIdFromUrl();
        if (t !== currentTicketId) {
            currentTicketId = t;
            resetTicketState();
        }
    }

    function scanAndAttach() {
        if (!isEnabled) return;
        checkTicketChange();
        const messages = document.querySelectorAll('[data-test-id="omni-log-message-content"]');
        messages.forEach(processCustomerMessage);
        addReplyTranslateButton();
    }

    function init() {
        // Idempotent: tear down any prior observer/poll so repeated toggles
        // don't stack handlers.
        teardownObservers();

        console.log('Zendesk Auto Translator initializing...');

        // Install the document-level auto-retranslate listener once.
        // It self-gates on isEnabled, so leaving it attached across
        // toggle cycles is safe and cheaper than churning attach/detach.
        installAutoRetranslateListener();
        // Same pattern for the PDF link interceptor — single document-
        // level listener, self-gates on isEnabled.
        installPdfClickInterceptor();
        // Macro autocomplete (Phase 4 #13). Same pattern: one document-
        // level listener, self-gates on isEnabled.
        installMacroAutocomplete();
        loadMacrosFromStorage();

        mainObserver = new MutationObserver(scanAndAttach);
        mainObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Polling backup: Zendesk's React re-renders the reply toolbar in ways
        // that don't always bubble a mutation our observer catches, and the
        // initial reply toolbar can render before our observer sees it. 1.5s
        // poll keeps the button sticky without noticeable overhead.
        pollTimer = setInterval(scanAndAttach, 1500);

        // Immediate first scan so we don't wait for the first mutation.
        setTimeout(scanAndAttach, 500);

        console.log('Zendesk Auto Translator ready!');
    }

    function teardownObservers() {
        if (mainObserver) { mainObserver.disconnect(); mainObserver = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function cleanup() {
        teardownObservers();
        restoreSwappedComments();
        document.querySelectorAll('.zt-translate-container, .zt-translate-row, .zt-translate-badge, .zt-translate-btn, .zt-translation-result, .zt-reply-wrapper, .zt-reply-translate-btn').forEach(el => el.remove());
        document.querySelectorAll('[data-zt-processed]').forEach(el => {
            delete el.dataset.ztProcessed;
        });
        // Clear stale language state so a toggle off/on can't reuse a
        // language from a different ticket view. data-zt-lang on individual
        // messages is preserved — it's per-message detection, not per-ticket.
        detectedCustomerLanguage = null;
        window.ztReplyButton = null;
        clearAutoRetranslateState();
        closeLanguageMenu();
        closePdfModal();
        closeMacroMenu();
    }

})();
