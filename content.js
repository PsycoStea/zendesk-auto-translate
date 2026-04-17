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
        try {
            return settings.provider === 'libretranslate' ? await libreDetect(text) : await googleDetect(text);
        } catch (err) {
            console.error('[zt] Language detection error:', err);
            showToast(readableError(err, providerLabel()), 'error');
            return 'unknown';
        }
    }

    async function translate(text, targetLang = 'en', sourceLang = 'auto') {
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
                chrome.storage.local.set({ translationMemory });
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
        
        // Update reply button if it exists
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

    function findCKEditorInstance(startNode) {
        let node = startNode;
        while (node && node !== document.body) {
            if (node.ckeditorInstance) return node.ckeditorInstance;
            node = node.parentElement;
        }
        const candidates = document.querySelectorAll('.ck-editor, .ck-editor__main, .ck.ck-editor, [class*="ck-editor"]');
        for (const c of candidates) {
            if (c.ckeditorInstance) return c.ckeditorInstance;
        }
        return null;
    }

    function contentMatches(replyArea, translated) {
        const current = (replyArea.innerText || replyArea.textContent || '').trim();
        const target = translated.trim();
        if (current === target) return true;
        const head = target.slice(0, Math.min(40, target.length));
        return head.length >= 10 && current.includes(head);
    }

    async function tryCKEditorApi(replyArea, translated) {
        const editor = findCKEditorInstance(replyArea);
        if (!editor || !editor.model) return false;
        try {
            editor.model.change(writer => {
                const root = editor.model.document.getRoot();
                writer.remove(writer.createRangeIn(root));
                const paragraph = writer.createElement('paragraph');
                writer.append(paragraph, root);
                writer.insertText(translated, paragraph, 0);
            });
            await sleep(80);
            return contentMatches(replyArea, translated);
        } catch (err) {
            console.warn('[zt] CKEditor API strategy failed:', err);
            return false;
        }
    }

    async function trySyntheticPaste(replyArea, translated) {
        try {
            replyArea.focus();
            await sleep(30);
            document.execCommand('selectAll', false, null);
            await sleep(30);

            const dt = new DataTransfer();
            dt.setData('text/plain', translated);
            dt.setData('text/html', translated.replace(/\n/g, '<br>'));

            const pasteEvent = new ClipboardEvent('paste', {
                clipboardData: dt,
                bubbles: true,
                cancelable: true
            });
            replyArea.dispatchEvent(pasteEvent);
            await sleep(150);
            return contentMatches(replyArea, translated);
        } catch (err) {
            console.warn('[zt] Synthetic paste strategy failed:', err);
            return false;
        }
    }

    async function tryBeforeInput(replyArea, translated) {
        try {
            replyArea.focus();
            await sleep(30);
            document.execCommand('selectAll', false, null);
            await sleep(30);

            const dt = new DataTransfer();
            dt.setData('text/plain', translated);

            const evt = new InputEvent('beforeinput', {
                inputType: 'insertReplacementText',
                data: translated,
                dataTransfer: dt,
                bubbles: true,
                cancelable: true
            });
            replyArea.dispatchEvent(evt);
            await sleep(150);
            return contentMatches(replyArea, translated);
        } catch (err) {
            console.warn('[zt] beforeinput strategy failed:', err);
            return false;
        }
    }

    async function tryClipboardWithExecPaste(replyArea, translated) {
        let previousClipboard = null;
        try {
            try { previousClipboard = await navigator.clipboard.readText(); } catch (_) {}
            await navigator.clipboard.writeText(translated);

            replyArea.focus();
            await sleep(30);

            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(replyArea);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('selectAll', false, null);
            await sleep(30);

            document.execCommand('paste');
            await sleep(200);

            return contentMatches(replyArea, translated);
        } catch (err) {
            console.warn('[zt] Clipboard+execPaste strategy failed:', err);
            return false;
        } finally {
            if (previousClipboard !== null) {
                try { await navigator.clipboard.writeText(previousClipboard); } catch (_) {}
            }
        }
    }

    async function replaceReplyText(replyArea, translated) {
        const strategies = [
            { name: 'ckeditor-api', run: tryCKEditorApi },
            { name: 'synthetic-paste', run: trySyntheticPaste },
            { name: 'beforeinput', run: tryBeforeInput },
            { name: 'clipboard-execpaste', run: tryClipboardWithExecPaste }
        ];
        for (const s of strategies) {
            const ok = await s.run(replyArea, translated);
            if (ok) {
                console.log(`[zt] Reply replaced via strategy: ${s.name}`);
                // Move caret to end
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
        alert('Could not replace reply text — no strategy worked. See console for details.');
        return false;
    }

    function addReplyTranslateButton() {
        if (document.querySelector('.zt-reply-translate-btn')) return;
        
        const enhanceButton = document.querySelector('[aria-label="Enhance writing"]');
        if (!enhanceButton) return;
        
        const toolbar = enhanceButton.closest('[role="toolbar"]');
        if (!toolbar) return;
        
        const buttonWrapper = document.createElement('div');
        buttonWrapper.className = 'sc-k83b6s-1 jXsvnN';
        
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

            const replyText = (replyArea.innerText || replyArea.textContent || '').trim();
            if (!replyText) {
                alert('Please write your reply first.');
                return;
            }

            const originalHTML = translateBtn.innerHTML;
            translateBtn.disabled = true;
            translateBtn.innerHTML = '⏳';
            translateBtn.style.cursor = 'wait';

            const translated = await translate(replyText, detectedCustomerLanguage, 'en');

            const ok = await replaceReplyText(replyArea, translated);

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
    
    function init() {
        console.log('Zendesk Auto Translator initializing...');
        
        const observer = new MutationObserver(() => {
            const messages = document.querySelectorAll('[data-test-id="omni-log-message-content"]');
            messages.forEach(processCustomerMessage);
            
            addReplyTranslateButton();
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        setTimeout(() => {
            const messages = document.querySelectorAll('[data-test-id="omni-log-message-content"]');
            messages.forEach(processCustomerMessage);
            addReplyTranslateButton();
        }, 2000);
        
        console.log('Zendesk Auto Translator ready!');
    }
    
    function cleanup() {
        document.querySelectorAll('.zt-translate-badge, .zt-translate-btn, .zt-translation-result, .zt-reply-translate-btn').forEach(el => el.remove());
        // Also unmark processed messages so a re-enable can re-render their UI.
        document.querySelectorAll('[data-zt-processed]').forEach(el => {
            delete el.dataset.ztProcessed;
        });
        window.ztReplyButton = null;
    }
    
})();
