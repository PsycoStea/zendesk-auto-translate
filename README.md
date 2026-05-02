# Zendesk Auto Translator

Internal Chrome extension for the **Mac Group Global** customer service team. Auto-detects languages in Zendesk customer messages, provides one-click translation in both directions, and adds a shared macro library with PDF attachments.

- Private GitHub repo: https://github.com/PsycoStea/zendesk-auto-translate
- Not published to the Chrome Web Store. The team lead distributes the extension folder directly (zip) and teammates load it unpacked.

---

## Features

### Translation

- **Customer messages auto-translated to English on load.** Non-English messages are detected, translated in place, and rendered with an "ENGLISH TRANSLATION:" header. A toggle button on each message switches between the translation and the original. Quoted email history (anything after the first `<blockquote>`) is preserved verbatim — never re-translated.
- **One-click reply translation.** A flag button appears in the reply toolbar showing the customer's detected language. Clicking it translates your English reply back to that language and inserts both the translated text and the English source separated by `---`, so the customer reads the translation and you can still review your original. Bind to `Cmd+Shift+X` (macOS) / `Ctrl+Shift+X` (Windows/Linux) — customizable at `chrome://extensions/shortcuts`.
- **Auto-retranslate on edit.** After the first reply translation lands, edits below the `---` separator trigger a fresh retranslation 2 seconds after you stop typing.
- **Language override dropdown.** A small `▾` next to the reply flag opens a dropdown of all 24 supported languages. Picking one writes through to the ticket-wide language lock so future replies in this ticket default to the new target, and immediately retranslates the current composer content.
- **Two providers, Google primary with LibreTranslate fallback.** Google Translate via the public `translate.googleapis.com` endpoint (no key); if a Google call fails, the same paragraph falls back to your self-hosted LibreTranslate server when configured. A 60s rate-limit cool-off kicks in on Google 429s.
- **Translation memory cache.** Up to 2000 recent translations cached locally per browser, LRU-evicted, keyed by the full source text + target language. Hit-rate visible in the popup. "Clear cache" button if you ever want to reset.
- **Image and URL preservation.** `<img>` tags and hyperlinks in customer messages and agent replies survive the full HTML→markdown→translate→HTML roundtrip with all attributes intact. Hyperlink `href` values are protected with `{{ztlinkN}}` tokens during translation so the URL never gets mangled.
- **Inline error toasts.** Timeouts, HTTP failures, missing configuration — all surface as visible toasts instead of silent failure.

### Macros

- **Custom macros with `//` autocomplete.** Type `//` followed by the start of a macro name in the reply composer. A dropdown anchored at the caret shows matches; arrow keys + Enter (or click) inserts the macro. Trigger requires whitespace or paragraph start before `//` so URLs like `https://example.com` don't accidentally fire it.
- **Rich-text macro editor.** Open from the popup's "Manage macros…" button. Bold, italic, underline, bulleted lists, links, blank-line spacing — all preserved through insertion. Zendesk placeholders like `{{ticket.requester.first_name}}` pass through verbatim and resolve when you send.
- **PDF attachments per macro.** Each macro can carry one or more PDFs. When the macro is inserted, the PDFs are auto-attached to the reply through Zendesk's normal upload pipeline (progress bar, cancel, etc. work as normal). 10MB per file, soft warning at 2MB.
- **Shared macro library on GitHub.** The extension syncs the entire macro library — including PDF attachments — with [`PsycoStea/zendesk-auto-translate-macros`](https://github.com/PsycoStea/zendesk-auto-translate-macros).
  - **Pull is anonymous.** Every teammate clicks "⬇ Pull" with zero setup — no GitHub account, no token. Pulls the latest macros and PDFs from the repo and merges by content equivalence (not by timestamp), so reverting a local edit by clicking Pull does what you'd expect.
  - **Push is admin-only.** Gated behind a fine-grained personal access token entered into the macros page settings. Only the team lead needs one. Push uploads changed JSON files and PDFs, and removes anything that's been deleted locally.

### PDF viewer

- **In-page PDF viewer for attachments.** Click any PDF link inside a customer or agent message and it opens in a fullscreen modal backed by Mozilla's PDF.js — no more leaving the ticket to read an attachment in a new tab. Modal closes on Escape, click outside, or the × button. Modifier-key clicks (Cmd/Ctrl/Shift/Alt/middle-click) and right-click context menus pass through untouched, so you can still open in a new tab when you want to.

### Quality of life

- **Enable/disable toggle** in the popup that re-renders the UI on existing messages when toggled back on.
- **Scroll preservation** across customer-message swaps. Toggling Show original ↔ Show translation no longer yanks the message under your cursor when source and translation differ in length.
- **Hidden diagnostic-log toggle** (`chrome.storage.local.set({ztDebug: true})`) for verbose `[zt]` logs when something needs investigating. Off by default; warnings and errors stay visible regardless.

---

## Install (for teammates)

1. Get the extension folder from the team lead (you'll receive a zip file).
2. Unzip it somewhere stable (e.g. `~/zendesk-auto-translate/`) — Chrome reads from this folder every time it starts, so don't put it in Downloads or anywhere you'd casually delete.
3. Open Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder.
5. Pin the extension from the puzzle-piece menu so the icon stays visible.
6. Open the macros page from the popup and click "⬇ Pull" to grab the team's shared macro library.

Updating to a newer version: replace the folder contents with the new zip, click the reload icon on the extension card at `chrome://extensions`, and hard-refresh any open Zendesk tabs (`Cmd+Shift+R` / `Ctrl+Shift+R`).

See `INSTALLATION_GUIDE.md` for the full end-user walkthrough including LibreTranslate configuration.

---

## File layout

```
manifest.json          Extension config (Manifest V3)
content.js             Runs on *.zendesk.com — UI, provider dispatch, macro autocomplete,
                       PDF interceptor, reply-paste strategies
src/translate-core.js  Pure helpers (HTML↔markdown, URL/img tokens, blockquote split). Exposed
                       as window.__ztCore in the browser; require()-able under Node for tests
background.js          Service worker — installs defaults, dispatches keyboard shortcut
popup.html / popup.js  Toolbar popup: toggle, fallback config, cache stats, Clear cache,
                       Manage macros button
macros.html /          Macros editor: opens in a tab from the popup; rich-text body,
  macros.js /            PDF attachment list, GitHub sync bar with Pull/Push;
  macros.css             reads/writes chrome.storage.local.macros + macroAttachments
styles.css             UI styling — badges, toasts, language dropdown, PDF modal,
                       composer macro autocomplete dropdown
lib/pdfjs/             Bundled Mozilla PDF.js (v5.6.205) — used by the in-page PDF viewer
icon*.png              Extension icons
package.json           Test harness only (jsdom devDep, node:test runner) — extension itself
                       has no Node runtime dependency
tests/                 node:test cases for the translate-core helpers (URL token round-trip,
                       markdown serialization, image protection, blockquote split, etc.)
.github/workflows/     CI: runs `npm test` on every push and PR to main
INSTALLATION_GUIDE.md  End-user setup + LibreTranslate configuration
QA_CHECKLIST.md        Pre-release smoke test
ROADMAP.md             v2 work plan + as-built notes per item
README.md              This file
```

---

## Providers

### Google Translate

Default. The extension calls `https://translate.googleapis.com/translate_a/single` — the same unofficial public endpoint the Google Translate web UI uses. No API key is required. Be aware this endpoint is undocumented and could be rate-limited or changed at any time; if that happens, switch to LibreTranslate. Google 429 responses trigger a shared 60-second cool-off; during that window the extension uses LibreTranslate when configured, or surfaces a toast explaining the situation when not.

### LibreTranslate (fallback)

Enter your server URL (e.g. `https://libretranslate.mydomain.com`) and optional API key in the popup's "Fallback translator (optional)" section, then click **Save settings**. Chrome prompts once for permission to make requests to that host — accept it.

The extension calls:
- `POST {url}/detect` — body `{ q }` (plus `api_key` if set).
- `POST {url}/translate` — body `{ q, source, target, format: "text" }` (plus `api_key` if set).

LibreTranslate is used as a per-paragraph fallback whenever Google fails (network, timeout, 5xx, blocked). Leave the URL blank to disable fallback entirely.

---

## How reply translation works

Zendesk's reply composer is CKEditor 5 + React. Direct DOM edits are reverted by CKEditor's model, which is why earlier attempts with `innerHTML`, `execCommand('insertText')`, and clipboard + `execCommand('paste')` all silently failed — the text would appear for a moment and vanish. The extension tries the strategies below in order and uses the first one that makes the new text stick:

1. `ckeditor-api` — look for the CKEditor instance on the editor DOM node (`.ckeditorInstance`) and replace via `editor.model.change(...)`.
2. `synthetic-paste` — dispatch a constructed `ClipboardEvent('paste')` with a `DataTransfer` payload. **This is the one that works in current Zendesk.**
3. `beforeinput` — dispatch an `InputEvent('beforeinput', { inputType: 'insertReplacementText' })`.
4. `clipboard-execpaste` — `navigator.clipboard.writeText` + `execCommand('paste')` as a last resort, with the user's clipboard restored afterwards.

The winning strategy is logged to the page console as `[zt] Reply replaced via strategy: <name>` when `ztDebug` is enabled.

Macro insertion uses a similar synthetic-paste flow, with one twist: it sets the DOM selection over the `//partial` trigger fragment and defers the paste with `setTimeout(0)` so CKEditor 5's selection observer has time to sync its model selection. The paste pipeline then atomically deletes the trigger and inserts the macro in its place.

PDF attachments on macro insertion go through the file-input upload path: the extension finds Zendesk's hidden `<input type="file" data-test-id="omnicomposer-external-file-uploader">`, sets `input.files = dataTransfer.files`, and dispatches `change` — exactly what a real "Attach" button click produces, so React/Lotus state updates correctly and uploads progress as normal.

---

## Security / privacy

- All settings, the translation cache, and macro PDFs are stored locally via `chrome.storage.local` (with `unlimitedStorage` for the PDFs). Nothing leaves the browser without an explicit action.
- No analytics, no telemetry, no error reporting service.
- Outbound network calls are limited to:
  - `https://*.zendesk.com/*` — host page
  - `https://translate.googleapis.com/*` — Google translation
  - `https://api.github.com/*`, `https://raw.githubusercontent.com/*` — macro library sync
  - `https://*.zdusercontent.com/*` — PDF attachments (when opening the in-page viewer)
  - The specific LibreTranslate host you granted permission for, if configured.
- The GitHub access token (admin-only, used for macro push) is stored in `chrome.storage.local` and never logged. Forget it from the macros page → Settings → "Forget token".
