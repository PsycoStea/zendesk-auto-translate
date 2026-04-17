# Zendesk Auto Translator - Chrome Extension
## Technical Documentation

---

## 📁 File Structure

```
zendesk-translator-extension/
├── manifest.json          # Extension configuration
├── content.js            # Main logic (runs on Zendesk pages)
├── background.js         # Service worker (background tasks)
├── popup.html            # Extension popup UI
├── popup.js              # Popup logic
├── styles.css            # UI styling
├── icon16.png            # Extension icon (16x16)
├── icon48.png            # Extension icon (48x48)
├── icon128.png           # Extension icon (128x128)
├── INSTALLATION_GUIDE.md # User guide for your team
└── README.md             # This file
```

---

## 🔧 How It Works

### Architecture:

1. **content.js** - Runs on all Zendesk pages
   - Detects customer message language
   - Adds translation UI (badges, buttons)
   - Handles translation requests
   - Manages translation memory cache

2. **background.js** - Service worker
   - Handles extension installation/updates
   - Keeps service worker alive
   - Minimal functionality (by design for stability)

3. **popup.html/js** - Extension popup
   - Shows current status
   - Enable/disable toggle
   - Translation cache stats

4. **styles.css** - UI styling
   - Matches Zendesk design
   - Clean, professional look

---

## 🎯 Key Features

### Translation Memory
- Caches up to 100 recent translations
- Stored locally in Chrome storage
- Automatically prunes oldest entries
- Significantly speeds up repeat translations

### Language Detection
- Uses Google Translate's auto-detect
- Samples first 500 characters
- Updates reply button automatically

### Smart DOM Handling
- MutationObserver watches for new messages
- Processes messages only once (prevents duplicates)
- Handles Zendesk's dynamic UI updates

---

## 🔄 Future Enhancements (Ideas)

### Short-term (Easy):
- [ ] Keyboard shortcuts (Ctrl+Shift+T to translate)
- [ ] Copy translation button
- [ ] Translation history viewer
- [ ] Export translation cache

### Medium-term (Moderate):
- [ ] Microsoft Translator option (better quality)
- [ ] DeepL integration (premium quality)
- [ ] Custom phrase library (team-shared)
- [ ] Statistics dashboard

### Long-term (Complex):
- [ ] Auto-translate on ticket open (optional)
- [ ] Quality rating system
- [ ] Team collaboration features
- [ ] Analytics and reporting

---

## 🛠️ Making Changes

### To modify the extension:

1. **Edit the relevant file** (content.js, popup.html, etc.)

2. **Go to `chrome://extensions/`**

3. **Click the reload icon** on the extension card

4. **Hard refresh Zendesk** (`Ctrl+Shift+R`)

### Common modifications:

#### Change button colors:
Edit `styles.css` - look for `.zt-translate-btn` background color

#### Add new languages:
Edit `content.js` - add to `languageInfo` object

#### Change translation memory size:
Edit `content.js` - change `if (keys.length >= 100)` to your desired limit

#### Modify UI text:
Edit `content.js` for button text, `popup.html` for popup text

---

## 📦 Packaging for Distribution

### Option 1: ZIP file (Current method)
```bash
# Zip the extension folder
zip -r zendesk-translator-v1.0.0.zip zendesk-translator-extension/

# Share the ZIP with team
# They unzip and load unpacked
```

### Option 2: CRX file (Easier for team)
1. Go to `chrome://extensions/`
2. Click "Pack extension"
3. Select the extension folder
4. Creates a `.crx` file
5. Team can drag-and-drop to install

**Note**: CRX installation may show security warnings (normal for unpublished extensions)

---

## 🐛 Debugging

### Check if extension is running:
1. Open Zendesk ticket
2. Press `F12` (DevTools)
3. Console tab
4. Should see: "Zendesk Auto Translator initializing..."

### Common issues:

**Translation not replacing text:**
- Check if using contenteditable div (not textarea)
- Verify innerHTML is being set
- Check if Zendesk updated their DOM structure

**Button not appearing:**
- Check if selector still matches Zendesk's HTML
- Verify MutationObserver is running
- Check console for errors

**Language not detecting:**
- Verify Google Translate API is accessible
- Check network tab for failed requests
- Confirm text is > 10 characters

### Useful console commands:
```javascript
// Check if extension loaded
console.log(document.querySelector('.zt-translate-badge'));

// Check translation memory
chrome.storage.local.get('translationMemory', (r) => console.log(r));

// Check enabled state
chrome.storage.local.get('enabled', (r) => console.log(r));

// Clear translation memory
chrome.storage.local.set({ translationMemory: {} });
```

---

## 🔐 Permissions Explained

### Required permissions:

**storage**
- Saves enable/disable state
- Stores translation memory cache
- Persists settings across sessions

**activeTab**
- Allows popup to query current tab state
- Shows detected language in popup

**host_permissions (*.zendesk.com)**
- Runs content script on all Zendesk domains
- Adds translation UI to Zendesk pages

**host_permissions (translate.googleapis.com)**
- Allows API calls to Google Translate
- Required for translation functionality

---

## 📊 Performance Optimization

### Current optimizations:

1. **Translation memory** - Caches frequently used translations
2. **DOM efficiency** - Only processes each message once
3. **Event delegation** - Minimal event listeners
4. **Lazy loading** - UI only added when needed

### Potential improvements:

- Pre-translate common phrases on load
- Batch multiple translations
- Use IndexedDB for larger cache
- Add service worker caching

---

## 🔄 Updating for Team

### When you make changes:

1. **Update version** in `manifest.json`
   ```json
   "version": "1.0.1"
   ```

2. **Update version** in `popup.html`
   ```html
   <span class="version">v1.0.1</span>
   ```

3. **Test thoroughly** on your machine

4. **Package the extension** (ZIP or CRX)

5. **Send to team** with update notes

6. **Team installs** using same method as initial install

---

## 🆘 Support Checklist

When team members report issues:

- [ ] Is extension enabled in chrome://extensions/?
- [ ] Is toggle switch ON in popup?
- [ ] Did they hard refresh Zendesk page?
- [ ] Are they on a Zendesk page (*.zendesk.com)?
- [ ] Any console errors?
- [ ] Chrome version (should be recent)?
- [ ] Did Zendesk update their interface recently?

---

## 📝 Notes

### Why Chrome Extension vs Tampermonkey?

**Advantages:**
- ✅ More reliable (doesn't depend on Tampermonkey)
- ✅ Better permissions control
- ✅ Cleaner UI integration
- ✅ Easier to distribute to team
- ✅ Can use Chrome storage API
- ✅ Professional appearance

**Considerations:**
- Requires manual updates (no auto-update without Chrome Web Store)
- Slightly more complex to develop
- Needs icon assets

### Security notes:

- All data stays local
- No external servers (except Google Translate API)
- No tracking or analytics
- No personal data collected
- Open source (team can audit code)

---

## 🎯 Success Metrics

Track these to measure effectiveness:

- Number of translations per day
- Average response time improvement
- Team adoption rate
- Cache hit rate (translations reused)
- Bug reports / issues

---

**Built with stability in mind. Happy translating! 🚀**
