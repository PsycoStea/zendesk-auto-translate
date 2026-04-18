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
        provider: 'google',
        libretranslateUrl: '',
        libretranslateApiKey: ''
    };

    function normalizeUrl(u) {
        return (u || '').trim().replace(/\/+$/, '');
    }

    chrome.storage.local.get(
        ['enabled', 'translationMemory', 'provider', 'libretranslateUrl', 'libretranslateApiKey'],
        (result) => {
            isEnabled = result.enabled !== false;
            translationMemory = result.translationMemory || {};
            settings.provider = result.provider || 'google';
            settings.libretranslateUrl = normalizeUrl(result.libretranslateUrl);
            settings.libretranslateApiKey = result.libretranslateApiKey || '';

            if (isEnabled) {
                console.log('Zendesk Auto Translator: Enabled, provider=' + settings.provider);
                init();
            }
        }
    );

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.provider) settings.provider = changes.provider.newValue || 'google';
        if (changes.libretranslateUrl) settings.libretranslateUrl = normalizeUrl(changes.libretranslateUrl.newValue);
        if (changes.libretranslateApiKey) settings.libretranslateApiKey = changes.libretranslateApiKey.newValue || '';
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
                provider: settings.provider
            });
        } else if (request.action === 'settingsUpdated') {
            // storage.onChanged handles the actual refresh; just acknowledge.
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

    async function googleDetect(text) {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text.slice(0, 500))}`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data[2] || 'unknown';
    }

    async function googleTranslate(text, target, source) {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetchWithTimeout(url);
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

    function providerLabel() {
        return settings.provider === 'libretranslate' ? 'LibreTranslate' : 'Google Translate';
    }

    async function detectLanguage(text) {
        if (!guardExtensionContext()) return 'unknown';
        try {
            return settings.provider === 'libretranslate' ? await libreDetect(text) : await googleDetect(text);
        } catch (err) {
            console.error('[zt] Language detection error:', err);
            showToast(readableError(err, providerLabel()), 'error');
            return 'unknown';
        }
    }

    // Bump when the translation pipeline changes in a way that would make
    // previously-cached results look wrong (e.g. paragraph-splitting, HTML
    // formatting preservation). Old entries with a different prefix become
    // unreachable and naturally evicted by the LRU trim.
    const CACHE_VERSION = 'v4';

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

    async function translate(text, targetLang = 'en', sourceLang = 'auto') {
        if (!guardExtensionContext()) return text;

        const providerKey = settings.provider === 'libretranslate' ? 'libre' : 'google';
        const memoryKey = `${CACHE_VERSION}:${providerKey}:${text.slice(0, 100)}_${targetLang}`;
        if (translationMemory[memoryKey]) {
            console.log('[zt] Using cached translation (key:', memoryKey.slice(0, 60) + '…)');
            return translationMemory[memoryKey];
        }

        try {
            const backend = settings.provider === 'libretranslate' ? libreTranslate : googleTranslate;

            // Translate each blank-line-separated paragraph independently.
            // Google's public endpoint (and some LibreTranslate configs)
            // collapse \n\n to \n in the response, which destroys the
            // greeting / body / sign-off spacing agents use. Splitting here
            // preserves paragraph structure; single \n inside a paragraph is
            // preserved by the providers.
            const paragraphs = text.split(/\n{2,}/);
            const translatedParagraphs = await Promise.all(
                paragraphs.map(async (p) => {
                    if (!p.trim()) return '';
                    // Swap every URL for a {{ztlink<N>}} token before
                    // translating, then put the real URLs back after.
                    // Tokens look like Zendesk placeholders, which
                    // translators preserve verbatim.
                    const { text: tokenized, urls } = protectUrls(p);
                    const translated = await backend(tokenized, targetLang, sourceLang);
                    const restored = restoreUrls(translated, urls);

                    // Since we already split on \n{2,} before sending each
                    // chunk, the input to this single backend call had no
                    // blank-line paragraph breaks inside it. Any \n{2,}
                    // that appears in the response is translator
                    // reformatting — most visibly, Google injects blank
                    // lines between numbered or bulleted list items.
                    // Collapse those back to single \n so the line
                    // structure matches the source.
                    return restored.replace(/\n{2,}/g, '\n');
                })
            );
            const out = translatedParagraphs.join('\n\n');

            if (out) {
                const keys = Object.keys(translationMemory);
                if (keys.length >= 100) delete translationMemory[keys[0]];
                translationMemory[memoryKey] = out;
                safeStorageSet({ translationMemory });
            }
            return out || text;
        } catch (err) {
            console.error('[zt] Translation error:', err);
            showToast(readableError(err, providerLabel()), 'error');
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
        const sourceMarkdown = htmlToMarkdownish(beforeHtml) || '';
        if (!sourceMarkdown.trim()) return;  // Nothing to translate (e.g. only a forwarded quote).

        // Cache the detected language on the element itself so ticket
        // switches (which clear data-zt-processed to force UI re-render)
        // don't burn a fresh API call for every previously-seen message.
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
        performAutoTranslate(messageBody, sourceMarkdown, afterHtml, langCode, badge, toggleBtn);
    }

    // Drive the auto-translate + in-place swap for one customer message.
    // Also wired as the retry handler on failure, so the same function
    // covers both initial run and user-triggered retry.
    async function performAutoTranslate(messageBody, sourceMarkdown, afterHtml, langCode, badge, toggleBtn) {
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
                performAutoTranslate(messageBody, sourceMarkdown, afterHtml, langCode, badge, toggleBtn);
            };
            return;
        }

        const translatedHtml = markdownishToHtml(translatedMarkdown);

        // Translated body = label + translated new-reply + quoted history
        // (untouched). The label keeps the "ENGLISH TRANSLATION:" visual
        // cue you asked to keep.
        const translatedBodyHtml =
            '<div class="zt-translation-label">ENGLISH TRANSLATION:</div>' +
            '<div class="zt-translation-body">' + translatedHtml + '</div>' +
            afterHtml;

        commentTranslatedHtml.set(messageBody, translatedBodyHtml);

        // Swap into translated view. Agent sees English by default.
        messageBody.innerHTML = translatedBodyHtml;
        messageBody.classList.add('zt-showing-translation');

        toggleBtn.disabled = false;
        toggleBtn.textContent = 'Show original';
        toggleBtn.onclick = () => {
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

    function serializeNodeAsMarkdown(node) {
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
            const inner = serializeNodeAsMarkdown(child);
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

    function htmlToMarkdownish(html) {
        const container = document.createElement('div');
        container.innerHTML = html || '';
        let md = serializeNodeAsMarkdown(container).replace(/\n{3,}/g, '\n\n');
        // Trim leading/trailing whitespace on each line. After the text-node
        // whitespace collapse above, formatting whitespace near <br>/<p>
        // boundaries shows up as a single space at line edges (e.g.
        // ".\n Alternativt" from "</a>\n<br>\n<b>"). Stripping per-line
        // cleans that up without affecting intentional spaces inside lines.
        md = md.split('\n').map(line => line.trim()).join('\n');
        return md.trim();
    }

    function markdownishToHtml(md) {
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
                    console.log(`[zt] Reply replaced via strategy: ${s.name}`);
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
                console.log(`[zt] Strategy ${s.name} did not stick, trying next`);
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

    function addReplyTranslateButton() {
        if (!isEnabled) return;

        // Ground truth for "what language should this reply button translate
        // to" is whatever the currently-visible customer message is in. The
        // global is useful as a fast path but can be stale after a ticket
        // switch — always reconcile with the visible-ticket language first.
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

            if (!detectedCustomerLanguage) {
                alert('No customer language detected. Please translate a customer message first.');
                return;
            }

            const replyArea = findVisibleComposer();
            if (!replyArea) {
                alert('Could not find the active reply area.');
                return;
            }

            // Extract formatted reply as a markdown-ish string. Translation
            // providers preserve the markdown syntax reliably, so the
            // roundtrip (HTML → markdown → translate → markdown → HTML)
            // keeps bold/italic/lists/links/line breaks intact.
            const replyHtml = replyArea.innerHTML || '';
            const replyMarkdown = htmlToMarkdownish(replyHtml);
            if (!replyMarkdown) {
                alert('Please write your reply first.');
                return;
            }

            // If the reply already has a '---' separator from a previous
            // translation, the agent is re-translating after editing the
            // English below the line. Take everything after the last
            // separator as the authoritative English source — the
            // translation above gets replaced. Without a separator, the
            // whole reply is the source.
            const sepRegex = /(?:^|\n\n)---\s*(?:\n\n|$)/g;
            let lastSepEnd = -1;
            let sepMatch;
            while ((sepMatch = sepRegex.exec(replyMarkdown)) !== null) {
                lastSepEnd = sepMatch.index + sepMatch[0].length;
            }
            const englishSource = (lastSepEnd >= 0
                ? replyMarkdown.slice(lastSepEnd)
                : replyMarkdown).trim();
            if (!englishSource) {
                alert('Please write your reply in English below the separator.');
                return;
            }

            console.groupCollapsed('[zt debug] reply translation pipeline');
            console.log('1. reply innerHTML:', replyHtml);
            console.log('2. reply markdown (full):', JSON.stringify(replyMarkdown));
            console.log('2b. english source:', JSON.stringify(englishSource));

            const originalHTML = translateBtn.innerHTML;
            translateBtn.disabled = true;
            translateBtn.innerHTML = '⏳';
            translateBtn.style.cursor = 'wait';

            const translatedMarkdown = await translate(englishSource, detectedCustomerLanguage, 'en');
            console.log('3. translated markdown (from provider):', JSON.stringify(translatedMarkdown));

            // Build the combined reply: translation, separator, original
            // English. Customer receives both versions; agent can re-click
            // the flag to refresh just the translation portion.
            const combinedMarkdown = `${translatedMarkdown}\n\n---\n\n${englishSource}`;
            const combinedHtml = markdownishToHtml(combinedMarkdown);
            console.log('4. combined HTML (about to inject):', combinedHtml);

            const ok = await replaceReplyText(replyArea, combinedMarkdown, combinedHtml);

            console.log('5. reply innerHTML after inject:', replyArea.innerHTML);
            console.log('5b. reply innerText after inject:', replyArea.innerText);
            console.groupEnd();

            translateBtn.innerHTML = ok ? '✓' : '⚠️';
            translateBtn.style.cursor = 'pointer';
            translateBtn.disabled = false;

            setTimeout(() => {
                translateBtn.innerHTML = originalHTML;
            }, 2000);
        });
        
        buttonWrapper.appendChild(translateBtn);
        toolbar.appendChild(buttonWrapper);
        
        // Store reference for updates
        window.ztReplyButton = translateBtn;
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
    }
    
})();
