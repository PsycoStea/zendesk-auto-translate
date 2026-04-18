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

### v1.0.25 (current)
- Diagnostic logging added on customer-message translation: each click writes a `[zt debug] customer message translation` group to the console containing the source `innerHTML`, the extracted markdown, the translator response, and the final HTML. Used to pin down whether list-item blank lines come from the source DOM, the translator response, or the rehydration. Will be removed once the spacing fix is confirmed.

### v1.0.24
- **Stop translator-introduced blank lines between numbered/bulleted list items.** When a customer message contained a numbered list (e.g. steps `1. … 2. … 3. …` on consecutive lines), Google reformatted the response by inserting blank lines between items. `markdownishToHtml` then interpreted those as paragraph breaks and emitted `<p><br></p>` sentinels — so the translation looked visually over-spaced vs. the tightly-packed source.
- Since each paragraph-level chunk is already split on `\n{2,}` *before* the backend call, there cannot legitimately be any `\n{2,}` in the response. Collapse any that do appear back to single `\n` right after the translator returns, so the line structure of the translation matches the line structure of the source.
- Cache version bumped to `v4:` so any previously-cached translations with the bloated blank lines are invalidated.

### v1.0.23
- **Preserve hyperlinks and bare URLs through translation.** Translators sometimes mangle the `[text](url)` markdown syntax used to represent hyperlinks — moving brackets around, dropping the URL, or occasionally translating words inside the URL — so links in customer messages and replies were getting stripped to plain text. Before sending any paragraph to the provider, every URL is now replaced with a `{{ztlink<N>}}` placeholder token (shape borrowed from Zendesk's own `{{ticket.requester.first_name}}` style, which translators pass through verbatim). The real URLs are restored after translation from a per-paragraph map.
- Hyperlinks (anchor tags) round-trip as real `<a>` tags with `target="_blank" rel="noopener noreferrer"`; the anchor text is translated, the URL is exact.
- Bare URLs in body text stay as bare URLs — no auto-linkification, matching agent preference.
- Markdown link parser now allows one level of nested parens in the URL so Wikipedia-style links (`…/Foo_(bar)`) survive the roundtrip.

### v1.0.22
- **Customer-message translation preserves the original spacing.** The old click handler ran the translator output through `split('\n').filter(line => line.length > 0).join('<br><br>')`, which unconditionally injected a blank line between every non-empty line — so a message with two consecutive lines (e.g. "Status: …" then "Solution: …") showed up in the translation with a blank line between them even though the customer hadn't typed one. Now the customer-message path uses the same HTML→markdown→translate→HTML roundtrip as the reply path: the message body's `innerHTML` is serialized to markdown-ish (so adjacent lines vs blank-line-separated blocks are distinguishable), translated per paragraph, and rehydrated with `<p>` tags and `<p><br></p>` sentinels. `.zt-translation-body p { margin: 0 }` so adjacent paragraphs sit on consecutive lines; sentinel paragraphs produce the visible blank lines via their `<br>` line-box.

### v1.0.21
- **More saturated pastels.** v1.0.20's muted pair (`#A8DADC` / `#B8E6B8`) read as desaturated rather than pastel. Keep the high-lightness pastel feel but bump saturation: badge `#A0E7E5` (teal, ~62% sat), button `#B4F1B4` (green, ~70% sat). Still soft enough not to compete with Zendesk's own UI, but actually colorful.

### v1.0.20
- **Pastel fills, dark text, no stroke.** Badge is `#A8DADC` (muted teal), button is `#B8E6B8` (muted green). Text is Zendesk's default dark slate `#2f3941` — plenty of contrast on the light fills without needing `-webkit-text-stroke`, which was making letters harder to read rather than easier.
- **Hover animation scoped to the button alone.** Dropped the row-level `:has()` lift that pulled both halves up together. The button now animates via `filter: brightness()` on hover and an inset shadow on active. The badge stays put so the seam between them doesn't shift.

### v1.0.19
- **Rectangle pair instead of pills.** Badge and button now sit in a shared `.zt-translate-row` wrapper with `display: inline-flex` and `overflow: hidden`. A small border-radius on the row rounds the outer corners while the shared edge between the two halves stays crisp — they read as one unit with a visible seam.
- **New colors.** Language badge is `#00F7FF` (cyan, so country flags stay readable), button is `#00FF08` (bright green). White text with `-webkit-text-stroke: 0.6px #000` makes the lettering pop against the bright fills; a small text-shadow adds subtle depth.
- **Animation lifts the whole row together** via `.zt-translate-row:has(.zt-translate-btn:hover:not(:disabled))`. Keeps the touching edges perfectly aligned during the 1px lift, then presses back down on active. Button itself gets a `filter: brightness()` darken on hover and active. Everything composited via transform / box-shadow / filter — zero idle cost.
- Result box and cleanup selectors updated to match the new container/row markup.

### v1.0.18
- **Modernized badge and button.** The customer-message language tag (e.g. `🇩🇰 Danish`) now uses a dark slate fill; the translate button uses Zendesk blue as an accent. Both share the same pill shape, font size, weight, and letter-spacing so they read as one visual family, with the dark/accent contrast carrying the info/action hierarchy. Button text is simplified to just "Translate" (no emoji, no "to English" — we're always translating to English on this side).
- **Hover + click feedback.** Button hover darkens the fill, lifts 1px, and deepens the shadow; active state presses back down with a tighter shadow. Animations are on `transform` and `box-shadow` only so they're GPU-composited and cost nothing while idle.
- **Translation result box** cleaned up to match — subtle gray background, slate accent border, uppercase-spaced label.

### v1.0.17
- **Bilingual reply output.** Clicking the flag now replaces the reply with: translation, a `<hr>` horizontal line (from `---`), and the original English below. Customer receives both versions in the sent email.
- **Re-translate from the authoritative English.** When the reply already contains a `---` separator from a previous click, the extension uses everything below the last separator as the English source and only rewrites the translation above. Agents can edit the English portion freely and click the flag again to refresh the translation without losing their edits. If the English portion has been fully deleted, an alert prompts the agent to write their reply first.
- Serializers updated to round-trip the separator in both directions: `htmlToMarkdownish` turns `<hr>` into a `---` block, `markdownishToHtml` emits `<hr>` for a `---`-only block. The text `---` alone wouldn't auto-convert to `<hr>` on paste in CKEditor — that transform only fires on keyboard input — so the tag is injected directly.

### v1.0.16
- **Stop the false "no strategy worked" toast** when synthetic-paste actually succeeded. After v1.0.15's serializer change, adjacent paragraphs in the target markdown are separated by `\n` while Chrome's `innerText` always emits `\n\n` between block elements — so the post-injection substring check in `contentMatches` failed on whitespace mismatch even though the reply landed correctly. Normalize whitespace on both sides of the comparison before checking.

### v1.0.15
- **Preserve Zendesk's blank-line sentinel paragraphs.** In Zendesk's CKEditor, adjacent `<p>` tags render as consecutive lines with no visible spacing — a visible blank line only appears when there's an empty `<p><br></p>` paragraph between them. The v1.0.9–v1.0.14 serializer emitted one `\n\n` per `<p>`, which meant `<p>A</p><p>B</p>` (adjacent, no blank) and `<p>A</p><p><br></p><p>B</p>` (blank-line separator) collapsed to the same markdown (`A\n\nB`). Rehydration couldn't tell them apart and produced only adjacent `<p>` tags — so translated replies lost every agent-inserted blank line, even though the diagnostic logs showed the text itself was correct.
- Now the serializer emits `\n` per paragraph (so adjacent `<p>` tags become `A\nB`) while empty `<p><br></p>` sentinels naturally produce `\n\n` (one from the `<br>`, one from the wrapping `<p>`, normalized). Rehydration splits the markdown on blank lines into "blocks", renders each block's lines as consecutive `<p>` tags, and inserts a `<p><br></p>` sentinel between blocks to match Zendesk's convention. Greeting / body / signature spacing now survives the roundtrip.
- Cache version bumped to `v3:` since the markdown format produced by the serializer changed — any old cache entries are unreachable.

### v1.0.14
- **Authoritative visible-ticket language resolution.** v1.0.13 used a global `detectedCustomerLanguage` updated only from visible messages, but that was still vulnerable to async races in `processCustomerMessage` (whichever message's detection promise resolved last won the global) and to `isElementVisible` returning the wrong answer for hiding techniques other than `display:none`. `addReplyTranslateButton` now derives the language synchronously from the first visible customer message that has a cached `data-zt-lang`, and reconciles the global against that before creating or updating the flag. If a visible message's language disagrees with the global, the visible message wins.
- **Stronger visibility check.** Switched to `Element.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })` when available (Chrome 105+). It handles `display:none`, `visibility:hidden`, `content-visibility:hidden`, and `opacity:0` on any ancestor — the older `offsetParent` fallback only caught `display:none` reliably.
- **Clear detected language on disable.** `cleanup()` now resets `detectedCustomerLanguage` so a toggle off/on cycle can't reuse a language from a previously-visited ticket.

### v1.0.13
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
