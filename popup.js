// Popup script for Zendesk Auto Translator

document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.getElementById('toggleSwitch');
    const statusText = document.getElementById('statusText');
    const statusIndicator = document.querySelector('.status-indicator');
    const detectedLanguage = document.getElementById('detectedLanguage');
    const memorySize = document.getElementById('memorySize');
    
    // Load current status
    chrome.storage.local.get(['enabled'], (result) => {
        const isEnabled = result.enabled !== false;
        toggleSwitch.checked = isEnabled;
        updateStatus(isEnabled);
    });
    
    // Query active tab for current status
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && tabs[0].url.includes('zendesk.com')) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, (response) => {
                if (chrome.runtime.lastError) {
                    // Extension not loaded on this page yet, that's okay
                    console.log('Extension not active on this page yet');
                    return;
                }
                
                if (response) {
                    detectedLanguage.textContent = response.detectedLanguage || 'None';
                    memorySize.textContent = response.memorySize || 0;
                }
            });
        }
    });
    
    // Handle toggle
    toggleSwitch.addEventListener('change', () => {
        const enabled = toggleSwitch.checked;
        
        chrome.storage.local.set({ enabled }, () => {
            updateStatus(enabled);
            
            // Notify all Zendesk tabs
            chrome.tabs.query({ url: 'https://*.zendesk.com/*' }, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { 
                        action: 'toggle', 
                        enabled 
                    });
                });
            });
        });
    });
    
    function updateStatus(enabled) {
        if (enabled) {
            statusText.textContent = 'Active';
            statusIndicator.classList.remove('inactive');
            statusIndicator.classList.add('active');
        } else {
            statusText.textContent = 'Disabled';
            statusIndicator.classList.remove('active');
            statusIndicator.classList.add('inactive');
        }
    }
});
