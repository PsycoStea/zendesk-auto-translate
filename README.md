# Zendesk Auto Translator

Internal Chrome extension for the **Mac Group Global** customer service team. Auto-detects languages in Zendesk customer messages and provides one-click translation in both directions, using either Google Translate or a self-hosted LibreTranslate instance.

- Private GitHub repo: https://github.com/PsycoStea/zendesk-auto-translate
- Not published to the Chrome Web Store — distribution is via clone + load unpacked.

---

## Features

- Language badge and "Translate to English" button on non-English customer messages.
- Flag button in the reply toolbar that translates your English reply back into the customer's detected language.
- Reply translation uses CKEditor-aware paste strategies so text actually sticks (see v1.0.7 notes below).
- Translation memory: up to 100 recent translations cached locally per browser, keyed by provider.
- Two selectable providers from the popup:
  - **Google Translate** — free, uses the public `translate.googleapis.com` endpoint (no key).
  - **LibreTranslate** — your own self-hosted server. Configure URL + optional API key in the popup; Chrome prompts once for permission to reach the host.
- Enable/disable toggle that correctly re-renders UI on existing messages when toggled back on.
- Inline error toasts for timeouts, HTTP failures, or missing configuration.

---

## Install (for teammates)

1. `git clone https://github.com/PsycoStea/zendesk-auto-translate.git` (or download the ZIP from GitHub and unzip it).
2. Open Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the cloned folder.
4. Pin the extension from the puzzle-piece menu so the icon is always visible.

Updating to a newer version: `git pull` in the folder, then click the reload icon on the extension card and hard-refresh any open Zendesk tabs (`Cmd+Shift+R` / `Ctrl+Shift+R`).

See `INSTALLATION_GUIDE.md` for the end-user walkthrough, including how to configure LibreTranslate.

---

## File layout

```
manifest.json          Extension config (Manifest V3)
content.js             Runs on *.zendesk.com — UI, provider dispatch, reply-paste strategies
background.js          Service worker — installs defaults
popup.html / popup.js  Toolbar popup: toggle, provider selector, LibreTranslate URL/key
styles.css             UI styling, including toast
icon*.png              Extension icons
INSTALLATION_GUIDE.md  End-user setup + LibreTranslate configuration
QA_CHECKLIST.md        Pre-release smoke test
README.md              This file
```

---

## Providers

### Google Translate
Default. The extension calls `https://translate.googleapis.com/translate_a/single` — the same unofficial public endpoint the Google Translate web UI uses. No API key is required. Be aware this endpoint is undocumented and could be rate-limited or changed at any time; if that happens, switch to LibreTranslate.

### LibreTranslate
Pick "LibreTranslate (self-hosted)" in the popup, enter your server URL (e.g. `https://libretranslate.mydomain.com`), optional API key, and click **Save settings**. Chrome will prompt once for permission to make requests to that host — accept it.

The extension calls:
- `POST {url}/detect` — body `{ q }` (plus `api_key` if set).
- `POST {url}/translate` — body `{ q, source, target, format: "text" }` (plus `api_key` if set).

If the server is unreachable you'll see an error toast; the extension will not silently fall back to Google — switch providers explicitly in the popup if needed.

---

## How reply translation works

Zendesk's reply composer is CKEditor 5 + React. Direct DOM edits are reverted by CKEditor's model, which is why earlier attempts with `innerHTML`, `execCommand('insertText')`, and clipboard + `execCommand('paste')` all silently failed — the text would appear for a moment and vanish. v1.0.7 tries these strategies in order and uses the first one that makes the new text stick:

1. `ckeditor-api` — look for the CKEditor instance on the editor DOM node (`.ckeditorInstance`) and replace via `editor.model.change(...)`.
2. `synthetic-paste` — dispatch a constructed `ClipboardEvent('paste')` with a `DataTransfer` payload. **This is the one that works in current Zendesk.**
3. `beforeinput` — dispatch an `InputEvent('beforeinput', { inputType: 'insertReplacementText' })`.
4. `clipboard-execpaste` — the old `navigator.clipboard.writeText` + `execCommand('paste')` path as a last resort, with the user's clipboard restored afterwards.

The winning strategy is logged to the page console as `[zt] Reply replaced via strategy: <name>`.

---

## Version history

### v1.0.13 (current)
- **Fix language bleed across open tickets.** v1.0.12's debug logs showed the reply formatting pipeline was correct end-to-end, but agents reported the reply button showing the wrong language after switching tickets — and translating into that wrong language. Root cause: `detectedCustomerLanguage` was a single global, and `processCustomerMessage` ran on every message in the DOM, including hidden ones from other open tickets. Whichever finished detection last set the global. Now the global is only written when the message being processed is visible; hidden tickets' messages still get their own per-message badges rendered but no longer leak their language into the visible ticket's reply button.
- **Cache detected language on each message element.** Switching tickets previously re-ran detection against the provider for every previously-seen message (because `data-zt-processed` gets cleared on ticket change to force UI rebuild). Detection result is now stored in `data-zt-lang` on the message, which survives the reset, so a tab switch back to a ticket uses zero extra API calls for messages already seen.

### v1.0.12
- **Multi-ticket fix.** Zendesk keeps multiple open tickets in the same DOM (only one is visible at a time). v1.0.11 and earlier used `document.querySelector` to find the reply composer and the "Enhance writing" toolbar, which returned the first match in DOM order — often a hidden ticket. The reply flag would then attach to an invisible toolbar and appear missing from the ticket the agent was looking at. Now we scan with visibility checks (`offsetParent`, bounding-rect dimensions) and always target the composer actually on screen. The wrapper-already-exists check is also scoped to the current toolbar so stale wrappers in hidden tabs don't block new buttons.
- **Cache version bust.** Translation-memory keys now carry a `v2:` prefix. Results cached under the old key format (from v1.0.9–v1.0.11's formatting roundtrip and per-paragraph fanout) become unreachable, so agents retranslating the same template after this update actually hit the new pipeline instead of getting a stale result.
- **Diagnostic logging on reply translation.** Every flag click logs the reply's innerHTML, the derived markdown, paragraph count in and out, the final HTML, and the post-injection state to the console under `[zt debug] reply translation pipeline`. Helps pinpoint where formatting loss happens (provider response vs. serializer vs. rehydrator). Will be removed once the roundtrip is confirmed solid on real templates.

### v1.0.11
- Preserve paragraph spacing across the translation request itself. Google's public endpoint (and some LibreTranslate deployments) collapse `\n\n` to `\n` in their response — which means a v1.0.10 reply with greeting / body / sign-off would come back with every line glued together into one paragraph. Now the reply is split on blank lines before translation and each paragraph is translated in parallel, then joined back with `\n\n`. Round-trip latency is the same as one request for a typical email-sized reply because the calls are parallel.

### v1.0.10
- Fix paragraph spacing in the HTML→markdown→HTML roundtrip. v1.0.9 emitted a single `\n` per `<p>`, so separate paragraphs collapsed into one paragraph with soft `<br>` breaks. Now emits `\n\n`, so a reply like `Hi\n\nBody\n\nRegards` round-trips to three distinct paragraphs and keeps the blank-line spacing agents use between greeting / body / signature.

### v1.0.9
- **Formatting preserved through translation.** The reply is extracted from CKEditor as HTML, converted to a lightweight markdown representation, translated, rehydrated to HTML, and injected via the clipboard pipeline. Bold/italic/underline, lists, links, and line breaks survive the round trip.
- **Injection simplified from 4 strategies to 2.** Based on the research memo in `docs/` (TL;DR: `synthetic-paste` is using CKEditor 5's documented clipboard pipeline, not a hack). Kept `ckeditor-api` (now fixed to search the composer subtree for `.ck-editor__editable*` and use `editor.setData(html)` when the instance is exposed) and `synthetic-paste`. Removed `beforeinput` (synthetic `InputEvent` is untrusted, editors ignore it) and `clipboard-execpaste` (deprecated, clobbers user clipboard).
- **Spellcheck suppressed during injection.** `spellcheck="false"` is set on the composer for the duration of the replacement and restored on the next frame, avoiding the brief red-squiggle flash while the OS spellchecker re-runs over new text.
- **Extension-context guard.** If the extension is reloaded while a Zendesk tab stays open, the content script no longer emits misleading "translation failed" toasts from dead `chrome.storage` calls — it shows a single warning toast telling the agent to refresh the tab and then goes silent.

### v1.0.8
- Per-ticket state reset: the detected customer language, badges, translation boxes, and reply button are cleared when the Zendesk ticket ID in the URL changes. Fixes the case where opening an English ticket after a non-English one would offer to translate your reply into the previous ticket's language.
- Reply button is no longer rendered for English-only tickets — it only appears once a non-English customer message has been detected on the current ticket.
- Observer/poll lifecycle: the main MutationObserver is now disconnected on disable, and a 1.5s poll backs up the observer for cases where Zendesk's reply toolbar renders without triggering a mutation at the document root. Fixes the v1.0.7 bug where the reply button only appeared after a disable/re-enable cycle and wouldn't disappear on disable.

### v1.0.7
- LibreTranslate support alongside Google Translate, selectable from the popup with runtime host-permission request.
- Error toasts for translation/detection failures; `AbortController` timeouts on all translator requests (8s).
- Reply translation rewritten with a layered CKEditor-aware strategy. `synthetic-paste` is what sticks in current Zendesk.
- Re-enable bug fixed — disabling then re-enabling now restores the badge/button on already-loaded customer messages.
- Popup simplified: removed the "How it works" block, added provider settings, updated footer to Mac Group Global.
- Translation-memory cache keys are now provider-prefixed so Google and LibreTranslate results don't bleed.

### v1.0.6
- Initial functional MVP with a clipboard-based reply workaround (silently reverted by CKEditor in some cases — fixed in 1.0.7).
- Google Translate only.
- Translation memory, enable/disable toggle, language badge, customer-message translation button.

---

## Security / privacy

- All settings and the translation cache are stored locally via `chrome.storage.local`. Nothing is synced.
- No analytics, no telemetry.
- Outbound network calls are limited to `https://*.zendesk.com/*`, `https://translate.googleapis.com/*`, and — if you've configured LibreTranslate — the specific host you granted permission for.
