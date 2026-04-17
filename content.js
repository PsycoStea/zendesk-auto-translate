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

    async function translate(text, targetLang = 'en', sourceLang = 'auto') {
        if (!guardExtensionContext()) return text;

        const providerKey = settings.provider === 'libretranslate' ? 'libre' : 'google';
        const memoryKey = `${providerKey}:${text.slice(0, 100)}_${targetLang}`;
        if (translationMemory[memoryKey]) {
            console.log('[zt] Using cached translation');
            return translationMemory[memoryKey];
        }

        try {
            const out = settings.provider === 'libretranslate'
                ? await libreTranslate(text, targetLang, sourceLang)
                : await googleTranslate(text, targetLang, sourceLang);

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
    
    async function processCustomerMessage(messageElement) {
        if (messageElement.dataset.ztProcessed) return;
        messageElement.dataset.ztProcessed = 'true';
        
        const messageBody = messageElement.querySelector('.zd-comment');
        if (!messageBody) return;
        
        const textContent = (messageBody.innerText || messageBody.textContent).trim();
        if (!textContent || textContent.length < 10) return;
        
        const langCode = await detectLanguage(textContent);
        if (langCode === 'en') return;
        
        detectedCustomerLanguage = langCode;

        // Try to add the reply button now that we know the language, and
        // update its content if it already exists.
        addReplyTranslateButton();
        updateReplyButton();
        
        const translationContainer = document.createElement('div');
        translationContainer.style.marginTop = '8px';
        translationContainer.style.marginBottom = '8px';
        
        const badge = document.createElement('div');
        badge.className = 'zt-translate-badge';
        badge.textContent = getLanguageDisplay(langCode);
        translationContainer.appendChild(badge);
        
        const translateBtn = document.createElement('button');
        translateBtn.className = 'zt-translate-btn';
        translateBtn.textContent = '📝 Translate to English';
        
        translateBtn.addEventListener('click', async () => {
            translateBtn.disabled = true;
            translateBtn.textContent = '⏳ Translating...';
            
            const translated = await translate(textContent, 'en', langCode);
            
            const resultDiv = document.createElement('div');
            resultDiv.className = 'zt-translation-result';
            
            const formattedTranslation = translated
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .join('<br><br>');
            
            resultDiv.innerHTML = `
                <div class="zt-translation-label">ENGLISH TRANSLATION:</div>
                <div style="white-space: pre-wrap;">${formattedTranslation}</div>
            `;
            
            translateBtn.after(resultDiv);
            translateBtn.textContent = '✓ Translated';
        });
        
        translationContainer.appendChild(translateBtn);
        messageElement.parentNode.insertBefore(translationContainer, messageElement.nextSibling);
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
                out += child.textContent;
                continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const tag = child.tagName.toLowerCase();
            const inner = serializeNodeAsMarkdown(child);
            switch (tag) {
                case 'br':
                    out += '\n';
                    break;
                case 'p':
                case 'div':
                    // Paragraphs end with a blank line so the markdown
                    // roundtrip rehydrates separate <p> tags rather than
                    // collapsing them into a single paragraph with <br>.
                    out += inner + '\n\n';
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
        return serializeNodeAsMarkdown(container).replace(/\n{3,}/g, '\n\n').trim();
    }

    function markdownishToHtml(md) {
        const lines = (md || '').split('\n');
        const out = [];
        let inList = false;
        let paragraph = [];

        const flushParagraph = () => {
            if (paragraph.length) {
                out.push('<p>' + paragraph.join('<br>') + '</p>');
                paragraph = [];
            }
        };

        const inlineFmt = (s) => {
            let r = escapeHtml(s);
            r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
            r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            r = r.replace(/__([^_]+)__/g, '<u>$1</u>');
            r = r.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
            return r;
        };

        for (const line of lines) {
            if (/^- /.test(line)) {
                flushParagraph();
                if (!inList) { out.push('<ul>'); inList = true; }
                out.push('<li>' + inlineFmt(line.slice(2)) + '</li>');
            } else if (line.trim() === '') {
                if (inList) { out.push('</ul>'); inList = false; }
                flushParagraph();
            } else {
                if (inList) { out.push('</ul>'); inList = false; }
                paragraph.push(inlineFmt(line));
            }
        }
        if (inList) out.push('</ul>');
        flushParagraph();
        return out.join('');
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
        const current = (replyArea.innerText || replyArea.textContent || '').trim();
        const target = stripMarkdownSyntax(translatedMarkdown);
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

    function addReplyTranslateButton() {
        if (!isEnabled) return;
        // Only render the reply translator when this ticket's customer is
        // actually writing in a non-English language. Prevents the button
        // appearing on English-only tickets with stale state from a prior
        // ticket.
        if (!detectedCustomerLanguage || detectedCustomerLanguage === 'en') return;
        if (document.querySelector('.zt-reply-wrapper')) return;

        const enhanceButton = document.querySelector('[aria-label="Enhance writing"]');
        if (!enhanceButton) return;

        const toolbar = enhanceButton.closest('[role="toolbar"]');
        if (!toolbar) return;

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

            const replyArea = document.querySelector('[contenteditable="true"][data-test-id="omnicomposer-rich-text-ckeditor"]');
            if (!replyArea) {
                alert('Could not find reply area.');
                return;
            }

            // Extract formatted reply as a markdown-ish string. Translation
            // providers preserve the markdown syntax reliably, so the
            // roundtrip (HTML → markdown → translate → markdown → HTML)
            // keeps bold/italic/lists/links/line breaks intact.
            const replyMarkdown = htmlToMarkdownish(replyArea.innerHTML || '');
            if (!replyMarkdown) {
                alert('Please write your reply first.');
                return;
            }

            const originalHTML = translateBtn.innerHTML;
            translateBtn.disabled = true;
            translateBtn.innerHTML = '⏳';
            translateBtn.style.cursor = 'wait';

            const translatedMarkdown = await translate(replyMarkdown, detectedCustomerLanguage, 'en');
            const translatedHtml = markdownishToHtml(translatedMarkdown);

            const ok = await replaceReplyText(replyArea, translatedMarkdown, translatedHtml);

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
        document.querySelectorAll('.zt-translate-badge, .zt-translate-btn, .zt-translation-result, .zt-reply-wrapper, .zt-reply-translate-btn').forEach(el => el.remove());
        document.querySelectorAll('[data-zt-processed]').forEach(el => {
            delete el.dataset.ztProcessed;
        });
        window.ztReplyButton = null;
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
        document.querySelectorAll('.zt-translate-badge, .zt-translate-btn, .zt-translation-result, .zt-reply-wrapper, .zt-reply-translate-btn').forEach(el => el.remove());
        document.querySelectorAll('[data-zt-processed]').forEach(el => {
            delete el.dataset.ztProcessed;
        });
        window.ztReplyButton = null;
    }
    
})();
