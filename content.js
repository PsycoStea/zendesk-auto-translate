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
    
    // Load settings and translation memory from storage
    chrome.storage.local.get(['enabled', 'translationMemory'], (result) => {
        isEnabled = result.enabled !== false; // Default to true
        translationMemory = result.translationMemory || {};
        
        if (isEnabled) {
            console.log('Zendesk Auto Translator: Enabled');
            init();
        }
    });
    
    // Listen for enable/disable from popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'toggle') {
            isEnabled = request.enabled;
            if (isEnabled) {
                init();
            } else {
                cleanup();
            }
            sendResponse({ success: true });
        } else if (request.action === 'getStatus') {
            sendResponse({ 
                enabled: isEnabled,
                detectedLanguage: detectedCustomerLanguage ? getLanguageDisplay(detectedCustomerLanguage) : null,
                memorySize: Object.keys(translationMemory).length
            });
        }
    });
    
    // ============================================
    // TRANSLATION API
    // ============================================
    
    async function detectLanguage(text) {
        try {
            const response = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text.slice(0, 500))}`);
            const data = await response.json();
            return data[2] || 'unknown';
        } catch (error) {
            console.error('Language detection error:', error);
            return 'unknown';
        }
    }
    
    async function translateWithGoogle(text, targetLang = 'en', sourceLang = 'auto') {
        // Check translation memory first
        const memoryKey = `${text.slice(0, 100)}_${targetLang}`;
        if (translationMemory[memoryKey]) {
            console.log('Using cached translation');
            return translationMemory[memoryKey];
        }
        
        try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
            const response = await fetch(url);
            const data = await response.json();
            
            let translatedText = '';
            if (data[0]) {
                data[0].forEach(item => {
                    if (item[0]) {
                        translatedText += item[0];
                    }
                });
            }
            
            // Store in translation memory (limit to 100 most recent)
            const keys = Object.keys(translationMemory);
            if (keys.length >= 100) {
                delete translationMemory[keys[0]]; // Remove oldest
            }
            translationMemory[memoryKey] = translatedText;
            
            // Save to storage
            chrome.storage.local.set({ translationMemory });
            
            return translatedText || text;
        } catch (error) {
            console.error('Translation error:', error);
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
            
            const translated = await translateWithGoogle(textContent, 'en', langCode);
            
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
            
            const translated = await translateWithGoogle(replyText, detectedCustomerLanguage, 'en');
            
            // CLIPBOARD METHOD: Copy translation to clipboard and paste it
            // This is the most native approach - CKEditor can't revert user paste events
            
            try {
                // Step 1: Copy translated text to clipboard
                await navigator.clipboard.writeText(translated);
                console.log('Copied translation to clipboard');
                
                // Step 2: Focus and select ALL text FIRST (critical order!)
                replyArea.focus();
                await new Promise(resolve => setTimeout(resolve, 50)); // Wait for focus
                
                // Select all content using multiple methods to ensure it works
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(replyArea);
                sel.removeAllRanges();
                sel.addRange(range);
                
                // Also use execCommand as backup
                document.execCommand('selectAll', false, null);
                
                console.log('Selected all text');
                
                // Wait a moment for selection to register
                await new Promise(resolve => setTimeout(resolve, 50));
                
                // Step 3: Now paste (this should replace the selected text)
                const pasteSuccess = document.execCommand('paste');
                
                if (pasteSuccess) {
                    console.log('Pasted via execCommand (should replace selected text)');
                } else {
                    // Fallback: Manual delete + insert
                    console.log('execCommand paste failed, using manual method');
                    
                    // Delete the selected content
                    document.execCommand('delete', false, null);
                    
                    // Wait for delete to process
                    await new Promise(resolve => setTimeout(resolve, 50));
                    
                    // Insert the translated text
                    document.execCommand('insertText', false, translated);
                    
                    console.log('Manually deleted and inserted text');
                }
                
                // Step 4: Wait for paste to complete
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Step 5: Move cursor to end
                const finalRange = document.createRange();
                const finalSel = window.getSelection();
                if (replyArea.childNodes.length > 0) {
                    finalRange.selectNodeContents(replyArea);
                    finalRange.collapse(false); // Collapse to end
                    finalSel.removeAllRanges();
                    finalSel.addRange(finalRange);
                }
                
                console.log('Translation complete via clipboard');
                
            } catch (error) {
                console.error('Clipboard method failed:', error);
                
                // Ultimate fallback: Direct text insertion with aggressive timing
                replyArea.focus();
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Clear and type slowly
                document.execCommand('selectAll');
                document.execCommand('delete');
                
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Type in small chunks with delays
                const chunkSize = 50;
                for (let i = 0; i < translated.length; i += chunkSize) {
                    const chunk = translated.substring(i, i + chunkSize);
                    document.execCommand('insertText', false, chunk);
                    await new Promise(resolve => setTimeout(resolve, 30));
                }
                
                console.log('Translation complete via slow typing fallback');
            }
            
            translateBtn.innerHTML = '✓';
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
        // Remove all translation UI elements
        document.querySelectorAll('.zt-translate-badge, .zt-translate-btn, .zt-translation-result, .zt-reply-translate-btn').forEach(el => el.remove());
    }
    
})();
