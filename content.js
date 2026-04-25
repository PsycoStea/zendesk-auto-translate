// Zendesk Auto Translator - Content Script
// This script runs on all Zendesk pages and handles translation

(function() {
    'use strict';

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
        ['enabled', 'translationMemory', 'libretranslateUrl', 'libretranslateApiKey', 'cacheStats', 'ztDebug', 'ticketLanguages'],
        (result) => {
            isEnabled = result.enabled !== false;
            translationMemory = result.translationMemory || {};
            settings.libretranslateUrl = normalizeUrl(result.libretranslateUrl);
            settings.libretranslateApiKey = result.libretranslateApiKey || '';
            ztDebug = !!result.ztDebug;
            ticketLanguages = (result.ticketLanguages && typeof result.ticketLanguages === 'object') ? result.ticketLanguages : {};
            // v1.0.40 migration: strip any 'en' entries written by
            // v1.0.34–v1.0.39's auto-detection. Those entries lock the
            // reply flag to the English emoji even on tickets whose later
            // customer messages are in another language, because Phase 1
            // #6's lock is permanent. New code skips writing 'en' (see
            // processCustomerMessage); this cleans up the historical
            // damage on first load after upgrade.
            {
                let migrated = false;
                for (const tid of Object.keys(ticketLanguages)) {
                    if (ticketLanguages[tid] === 'en') {
                        delete ticketLanguages[tid];
                        migrated = true;
                    }
                }
                if (migrated) persistTicketLanguages();
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
    const CACHE_VERSION = 'v5';

    // Translators sometimes mangle markdown-style links ([text](url)) —
    // moving the brackets around, dropping the URL, or translating words
    // inside the URL. To preserve hyperlinks and bare URLs exactly,
    // replace every URL with a {{ztlink<N>}} token before translating
    // and swap the real URL back after. Tokens shaped like Zendesk
    // placeholders ride through translators unchanged (we've seen Google
    // preserve {{ticket.requester.first_name}} through many roundtrips).

    function makeUrlToken(idx) {
        return `{{ztlink${idx}}}`;
    }

    function protectUrls(text) {
        const urls = [];
        let out = text;

        // Markdown links first. Allow one level of nested parens in the
        // URL so Wikipedia-style links (…Foo_(bar)) survive.
        out = out.replace(
            /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g,
            (_match, txt, url) => {
                urls.push(url);
                return `[${txt}](${makeUrlToken(urls.length - 1)})`;
            }
        );

        // Bare http(s) URLs. Trailing punctuation (period, comma, close
        // paren, etc.) is split off so "See https://example.com." doesn't
        // capture the period as part of the URL.
        out = out.replace(
            /https?:\/\/[^\s<>"'`]+/g,
            (url) => {
                const trailMatch = url.match(/[.,;:!?"'\])]+$/);
                const trailing = trailMatch ? trailMatch[0] : '';
                const cleanUrl = trailing ? url.slice(0, -trailing.length) : url;
                urls.push(cleanUrl);
                return makeUrlToken(urls.length - 1) + trailing;
            }
        );

        return { text: out, urls };
    }

    function restoreUrls(text, urls) {
        return text.replace(/\{\{ztlink(\d+)\}\}/g, (match, idx) => {
            const i = parseInt(idx, 10);
            return i < urls.length && urls[i] != null ? urls[i] : match;
        });
    }

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
        const memoryKey = `${CACHE_VERSION}:${text.slice(0, 100)}_${targetLang}`;
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
    function splitCommentAtFirstBlockquote(commentEl) {
        if (!commentEl.querySelector('blockquote')) {
            return { beforeHtml: commentEl.innerHTML, afterHtml: '' };
        }
        const beforeClone = commentEl.cloneNode(true);
        const afterClone = commentEl.cloneNode(true);
        trimFromFirstBlockquote(beforeClone);
        trimBeforeFirstBlockquote(afterClone);
        return { beforeHtml: beforeClone.innerHTML, afterHtml: afterClone.innerHTML };
    }

    function trimFromFirstBlockquote(root) {
        const bq = root.querySelector('blockquote');
        if (!bq) return;
        // Remove bq's following siblings and bq itself.
        while (bq.nextSibling) bq.parentNode.removeChild(bq.nextSibling);
        let current = bq.parentNode;
        bq.parentNode.removeChild(bq);
        // Walk up: at each ancestor level, strip trailing siblings (keep
        // ancestors themselves — they still hold content that came before
        // the blockquote).
        while (current && current !== root) {
            while (current.nextSibling) current.parentNode.removeChild(current.nextSibling);
            current = current.parentNode;
        }
    }

    function trimBeforeFirstBlockquote(root) {
        const bq = root.querySelector('blockquote');
        if (!bq) return;
        while (bq.previousSibling) bq.parentNode.removeChild(bq.previousSibling);
        let current = bq.parentNode;
        while (current && current !== root) {
            while (current.previousSibling) current.parentNode.removeChild(current.previousSibling);
            current = current.parentNode;
        }
    }

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

        // Detection precedence:
        //   1. Per-message data-zt-lang (already detected on this element).
        //   2. Ticket-wide lock from chrome.storage.local.ticketLanguages —
        //      but only when this message is in the currently visible
        //      ticket panel. Zendesk keeps multiple tickets in the same
        //      DOM and getTicketIdFromUrl() only knows the active one, so
        //      applying ticket A's lock to a hidden ticket B's message
        //      would mis-translate.
        //   3. Provider call. After detection, persist a non-'unknown'
        //      result to the ticket lock so future messages on this same
        //      ticket skip detection.
        let langCode = messageElement.dataset.ztLang;
        if (!langCode) {
            const ticketId = getTicketIdFromUrl();
            const visible = isElementVisible(messageElement);

            if (ticketId && visible && ticketLanguages[ticketId]) {
                langCode = ticketLanguages[ticketId];
                messageElement.dataset.ztLang = langCode;
            } else {
                langCode = await detectLanguage(textContent);
                messageElement.dataset.ztLang = langCode;
                // Persist only confident, non-English detections from the
                // visible ticket. 'unknown' means the providers couldn't
                // decide. 'en' is excluded on purpose (v1.0.40): a short
                // first message — a number, an address, "ok thanks" —
                // detects as English even on tickets whose later messages
                // are clearly in another language. Caching 'en' here
                // would lock the ticket out of further detection forever
                // (Phase 1 #6 lock is permanent), and the reply flag
                // would freeze on the English flag emoji. Skipping 'en'
                // means subsequent customer messages get re-detected
                // until a non-English one wins; the per-message
                // data-zt-lang cache still avoids redundant API calls
                // for messages we've already seen.
                if (
                    visible
                    && ticketId
                    && langCode
                    && langCode !== 'unknown'
                    && langCode !== 'en'
                    && ticketLanguages[ticketId] !== langCode
                ) {
                    ticketLanguages[ticketId] = langCode;
                    persistTicketLanguages();
                }
            }
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

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Image preservation (Phase 2 #9). Each <img> encountered in the
    // walk is pushed into the supplied `imgs` array as its outerHTML,
    // and the markdown gets a `{{ztimgN}}` token where N is the array
    // index. Translators preserve `{{...}}` tokens verbatim (same
    // mechanism the URL protector relies on), so images survive
    // translation and `markdownishToHtml` swaps the tokens back to raw
    // <img> tags. Alt text is left untranslated on purpose — translating
    // it for screen readers risks ungrammatical phrasing in the target
    // language and provides little value to sighted agents/customers.
    function serializeNodeAsMarkdown(node, imgs) {
        let out = '';
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                // HTML collapses runs of whitespace (including literal
                // newlines between tags, which are just source formatting)
                // into a single space when rendering. Do the same here so
                // those formatting newlines don't show up as real line
                // breaks in the markdown — only <br> and block elements
                // should produce newlines.
                out += child.textContent.replace(/\s+/g, ' ');
                continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const tag = child.tagName.toLowerCase();
            if (tag === 'img') {
                // No recursion — <img> is void. Token records the
                // outerHTML so all attributes (src, alt, width, height,
                // style) round-trip exactly.
                imgs.push(child.outerHTML);
                out += `{{ztimg${imgs.length - 1}}}`;
                continue;
            }
            const inner = serializeNodeAsMarkdown(child, imgs);
            switch (tag) {
                case 'br':
                    out += '\n';
                    break;
                case 'hr':
                    // Horizontal rule becomes '---' on its own line in
                    // markdown. Surround with blank lines so it's a
                    // distinct block when we split on /\n{2,}/ later.
                    out += '\n\n---\n\n';
                    break;
                case 'p':
                case 'div':
                    // Single newline per paragraph. In Zendesk's CKEditor,
                    // adjacent <p> tags render as consecutive lines without
                    // a visible blank line — only an empty <p><br></p>
                    // sentinel produces a visible blank. Serializing as one
                    // '\n' per paragraph means:
                    //   <p>A</p><p>B</p>       → "A\nB"   (adjacent)
                    //   <p>A</p><p><br></p><p>B</p> → "A\n\n\nB" → "A\n\nB" (blank)
                    // after normalization of \n{3,} to \n\n. The distinction
                    // is carried through the translator and rehydrated with
                    // sentinels in markdownishToHtml.
                    out += inner + '\n';
                    break;
                case 'strong':
                case 'b':
                    out += inner ? `**${inner}**` : '';
                    break;
                case 'em':
                case 'i':
                    out += inner ? `*${inner}*` : '';
                    break;
                case 'u':
                    out += inner ? `__${inner}__` : '';
                    break;
                case 'ul':
                case 'ol':
                    out += inner + '\n';
                    break;
                case 'li':
                    out += `- ${inner}\n`;
                    break;
                case 'a': {
                    const href = child.getAttribute('href') || '';
                    out += href && inner ? `[${inner}](${href})` : inner;
                    break;
                }
                default:
                    out += inner;
            }
        }
        return out;
    }

    // Returns { md, imgs }. `imgs` is the array of <img> outerHTML
    // strings indexed by the `{{ztimgN}}` tokens embedded in `md`. Pass
    // both through to `markdownishToHtml(translated, imgs)` after
    // translating to restore the originals exactly.
    function htmlToMarkdownish(html) {
        const container = document.createElement('div');
        container.innerHTML = html || '';
        const imgs = [];
        let md = serializeNodeAsMarkdown(container, imgs).replace(/\n{3,}/g, '\n\n');
        // Trim leading/trailing whitespace on each line. After the text-node
        // whitespace collapse above, formatting whitespace near <br>/<p>
        // boundaries shows up as a single space at line edges (e.g.
        // ".\n Alternativt" from "</a>\n<br>\n<b>"). Stripping per-line
        // cleans that up without affecting intentional spaces inside lines.
        md = md.split('\n').map(line => line.trim()).join('\n');
        return { md: md.trim(), imgs };
    }

    function markdownishToHtml(md, imgs) {
        // `imgs` is the array returned alongside the markdown by
        // htmlToMarkdownish — outerHTML for each <img>, indexed by the
        // {{ztimgN}} tokens embedded in `md`. Optional; when absent or
        // empty, image tokens are simply removed from the output (e.g.
        // a translation produced from text without images).
        const imgList = Array.isArray(imgs) ? imgs : [];

        // Split on blank lines into "blocks". Each block is a group of
        // consecutive lines with no blank line between them (i.e. what the
        // agent typed as a single continuous thought — greeting, body, or
        // sign-off). Between blocks, insert a <p><br></p> sentinel so
        // Zendesk's CKEditor renders a visible blank line. Within a block,
        // each line becomes its own <p> (Zendesk's convention for a single
        // Enter press).
        const blocks = (md || '').split(/\n{2,}/);
        const parts = [];
        let inList = false;
        let firstBlockEmitted = false;

        const closeList = () => {
            if (inList) { parts.push('</ul>'); inList = false; }
        };

        // Restore {{ztimgN}} tokens to the original <img> outerHTML.
        // Done *after* escapeHtml below so the token's raw form is what
        // we replace — escapeHtml leaves `{` and `}` untouched, so the
        // token text passes through escaping intact and we substitute
        // unescaped img markup.
        const restoreImageTokens = (s) => {
            return s.replace(/\{\{ztimg(\d+)\}\}/g, (match, idx) => {
                const i = parseInt(idx, 10);
                return i < imgList.length && imgList[i] != null ? imgList[i] : '';
            });
        };

        const inlineFmt = (s) => {
            let r = escapeHtml(s);
            // Markdown link. Allow one level of nested parens in the URL
            // (Wikipedia-style). Emit a real <a> with safe target/rel.
            r = r.replace(
                /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g,
                (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`
            );
            r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            r = r.replace(/__([^_]+)__/g, '<u>$1</u>');
            r = r.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
            // Image-token swap last so the unescaped <img> markup
            // doesn't get mangled by any of the steps above.
            r = restoreImageTokens(r);
            return r;
        };

        for (const block of blocks) {
            if (!block.trim()) continue;

            if (firstBlockEmitted) {
                closeList();
                parts.push('<p><br></p>');  // Zendesk blank-line sentinel.
            }
            firstBlockEmitted = true;

            // A block consisting of only '---' becomes a horizontal rule.
            // CKEditor preserves <hr> on paste but does not transform the
            // literal text '---' to an <hr> (that autocorrect only fires
            // on keyboard input), so we need to emit the tag directly.
            if (block.trim() === '---') {
                closeList();
                parts.push('<hr>');
                continue;
            }

            const lines = block.split('\n');
            for (const line of lines) {
                if (/^- /.test(line)) {
                    if (!inList) { parts.push('<ul>'); inList = true; }
                    parts.push('<li>' + inlineFmt(line.slice(2)) + '</li>');
                } else if (line.trim()) {
                    closeList();
                    parts.push('<p>' + inlineFmt(line) + '</p>');
                }
            }
        }

        closeList();
        return parts.join('');
    }

    function stripMarkdownSyntax(md) {
        return (md || '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\*\*/g, '')
            .replace(/(^|[^*])\*/g, '$1')
            .replace(/__/g, '')
            .trim();
    }

    function contentMatches(replyArea, translatedMarkdown) {
        // Normalize whitespace on both sides before comparing. The target
        // markdown uses '\n' for adjacent paragraphs and '\n\n' for
        // blank-line separators, but Chrome's innerText emits '\n\n'
        // between every pair of block elements — including adjacent <p>s —
        // so a literal substring check would always fail at the first
        // paragraph boundary even when the text landed correctly.
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const current = norm(replyArea.innerText || replyArea.textContent);
        const target = norm(stripMarkdownSyntax(translatedMarkdown));
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

    // Pull "everything after the last `---` separator" out of the reply's
    // markdown. Used by both the click handler (precondition check) and
    // the auto-retranslate debounce (change detection). Without a
    // separator, the whole markdown is the source.
    function extractEnglishSourceFromMarkdown(md) {
        const sepRegex = /(?:^|\n\n)---\s*(?:\n\n|$)/g;
        let lastSepEnd = -1;
        let m;
        while ((m = sepRegex.exec(md)) !== null) {
            lastSepEnd = m.index + m[0].length;
        }
        return (lastSepEnd >= 0 ? md.slice(lastSepEnd) : md).trim();
    }

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
                console.log('[zt-auto] skip: inProgress', { type: ev.type });
                return;
            }
            const composer = ev.target && ev.target.closest
                ? ev.target.closest('[contenteditable="true"][data-test-id="omnicomposer-rich-text-ckeditor"]')
                : null;
            if (!composer) return;  // common: events from outside the composer
            if (!isElementVisible(composer)) {
                console.log('[zt-auto] skip: composer not visible', { type: ev.type });
                return;
            }
            if (!composer.querySelector('hr')) {
                // No <hr> = no first translation yet, or agent deleted
                // the separator. Quiet because this is the steady state
                // before any reply is translated.
                return;
            }

            const eng = extractEnglishSourceFromMarkdown(htmlToMarkdownish(composer.innerHTML || '').md);
            console.log('[zt-auto] event', {
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
                    console.log('[zt-auto] debounce skip: inProgress');
                    return;
                }
                const live = findVisibleComposer();
                if (!live || !live.isConnected) {
                    console.log('[zt-auto] debounce skip: composer gone');
                    return;
                }
                if (!live.querySelector('hr')) {
                    console.log('[zt-auto] debounce skip: no <hr>');
                    return;
                }
                const eng2 = extractEnglishSourceFromMarkdown(htmlToMarkdownish(live.innerHTML || '').md);
                if (!eng2 || eng2 === autoRetranslate.lastEnglish) {
                    console.log('[zt-auto] debounce skip: eng2 matches lastEnglish', {
                        eng2: eng2 ? eng2.slice(0, 60) : eng2,
                        lastEnglish: autoRetranslate.lastEnglish ? autoRetranslate.lastEnglish.slice(0, 60) : autoRetranslate.lastEnglish,
                    });
                    return;
                }
                console.log('[zt-auto] FIRE runReplyTranslate', {
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
            console.log('[zt-auto] runReplyTranslate skip: inProgress');
            return false;
        }
        if (!detectedCustomerLanguage) {
            console.log('[zt-auto] runReplyTranslate skip: no detectedCustomerLanguage');
            return false;
        }

        const replyHtml = replyArea.innerHTML || '';
        const { md: replyMarkdown, imgs: replyImgs } = htmlToMarkdownish(replyHtml);
        const englishSource = extractEnglishSourceFromMarkdown(replyMarkdown);
        if (!englishSource) {
            console.log('[zt-auto] runReplyTranslate skip: no englishSource');
            return false;
        }
        console.log('[zt-auto] runReplyTranslate start', { englishSource: englishSource.slice(0, 60), targetLang: detectedCustomerLanguage });

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
            console.log('[zt-auto] runReplyTranslate end', { ok, lastEnglish: autoRetranslate.lastEnglish.slice(0, 60) });

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
        console.log('[zt-auto] selectLanguageOverride start', { code, prev: detectedCustomerLanguage });
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
        console.log('[zt-auto] selectLanguageOverride about to runReplyTranslate', { code, englishSource: englishSource.slice(0, 60) });
        await runReplyTranslate(replyArea, findVisibleReplyButton());
        console.log('[zt-auto] selectLanguageOverride done', { lastEnglish: autoRetranslate.lastEnglish.slice(0, 60), detectedLang: detectedCustomerLanguage });
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
    }

})();
