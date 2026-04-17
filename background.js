// Background service worker for Zendesk Auto Translator

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('Zendesk Auto Translator installed');
        
        // Set default settings
        chrome.storage.local.set({
            enabled: true,
            translationMemory: {}
        });
    } else if (details.reason === 'update') {
        console.log('Zendesk Auto Translator updated to', chrome.runtime.getManifest().version);
    }
});

// Keep service worker alive
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Echo back to keep connection alive
    sendResponse({ received: true });
    return true;
});
