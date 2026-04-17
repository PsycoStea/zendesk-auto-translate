# Installation Guide — Zendesk Auto Translator

Internal extension for the Mac Group Global customer service team. Not on the Chrome Web Store; installed manually from our private GitHub repo.

---

## 1. Get the code

Option A — git (recommended, so you can pull updates):

```
git clone https://github.com/PsycoStea/zendesk-auto-translate.git
```

Option B — download ZIP from https://github.com/PsycoStea/zendesk-auto-translate and unzip it somewhere permanent. **Don't delete the folder** — Chrome loads the extension directly from it.

---

## 2. Load into Chrome

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select the folder from step 1.
5. You should now see "Zendesk Auto Translator" in the list.
6. Click the puzzle-piece icon in Chrome's toolbar and pin the extension so its icon stays visible.

---

## 3. Verify it works

1. Open any Zendesk ticket that has a non-English customer message.
2. A colored badge (e.g. `🇩🇪 German`) should appear on the message, with a "Translate to English" button underneath.
3. Click the button — the translation appears in a blue box.
4. In the reply area, the toolbar shows a flag button matching the customer's language.
5. Type your reply in English, click the flag, and the text should be replaced with the translated version and stay replaced.

If none of that appears, hard-refresh the Zendesk tab (`Cmd+Shift+R` on Mac, `Ctrl+Shift+R` on Windows).

---

## 4. Choose a translation provider

Click the extension icon in Chrome's toolbar to open the popup. You'll see a **Translation Provider** section with two options:

### Google Translate (default)
Nothing to configure. Free, uses Google's public endpoint. Good enough for daily use but undocumented — if it ever stops working, switch to LibreTranslate.

### LibreTranslate (self-hosted)
1. Select the **LibreTranslate (self-hosted)** radio.
2. **Server URL** — the full URL to your LibreTranslate instance, e.g. `https://libretranslate.mydomain.com`. No trailing slash.
3. **API key (optional)** — only needed if your LibreTranslate instance enforces one. Leave blank otherwise.
4. Click **Save settings**.
5. Chrome will prompt you for permission to reach that host — click **Allow**.
6. The status row at the top of the popup updates to show the active provider.

You can switch providers at any time — translations are cached separately per provider, so switching won't lose anything.

---

## 5. Everyday use

- **Customer message** → click "Translate to English" on the message. Blue box with the translation appears.
- **Your reply** → type in English, click the flag button in the reply toolbar. Your text is replaced with the translation.
- **Disable temporarily** → click the extension icon and toggle the Enable switch. All translation UI disappears until you toggle it back on.

---

## 6. Getting updates

Updates are pushed to the GitHub repo. To update your local copy:

- If you used `git clone`: `git pull` in the folder, then open `chrome://extensions`, click the reload (↻) icon on the extension card, and hard-refresh any open Zendesk tabs.
- If you downloaded a ZIP: download the new ZIP, replace the old folder, then reload in `chrome://extensions`.

---

## Troubleshooting

**Nothing shows up on Zendesk.** Hard-refresh the Zendesk tab (`Cmd+Shift+R`). If still nothing, check `chrome://extensions` — make sure the extension is enabled and has no error badge.

**Reply text doesn't change or immediately reverts.** Open DevTools on the Zendesk tab (`F12` or right-click → Inspect) and look for a `[zt] Reply replaced via strategy: ...` log when you click the flag. If you see `[zt] All reply replacement strategies failed`, tell the developer — Zendesk's composer may have changed.

**Translation error toast appears.** The message tells you which provider failed and why. For LibreTranslate, check the URL in the popup is reachable from your browser (try opening `{URL}/languages` in a new tab). For Google, it's usually a rate-limit; wait a minute and retry, or switch to LibreTranslate.

**Extension says "Extension context invalidated" in the console.** You reloaded the extension but not the tab. Refresh the Zendesk tab.

**Toggle re-enable doesn't bring back buttons on old messages.** This was a bug in v1.0.6 — upgrade to v1.0.7 (`git pull`).

---

## Privacy

- Settings and the translation cache are stored locally in your browser via `chrome.storage.local` — nothing syncs to Google or anywhere else.
- The only outbound network calls are to `*.zendesk.com`, `translate.googleapis.com` (when using Google), and your own LibreTranslate host (when using LibreTranslate).
- No analytics, no telemetry, no third parties.
