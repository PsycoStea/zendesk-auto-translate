# Zendesk Auto Translator

Internal Chrome extension for the **Mac Group Global** customer service team. Auto-detects languages in Zendesk customer messages and provides one-click translation in both directions, using either Google Translate or a self-hosted LibreTranslate instance.

- Private GitHub repo: https://github.com/PsycoStea/zendesk-auto-translate
- Not published to the Chrome Web Store — distribution is via clone + load unpacked.

---

## Features

- Language badge and "Translate to English" button on non-English customer messages.
- Flag button in the reply toolbar that translates your English reply back into the customer's detected language. Also bindable to `Cmd+Shift+X` (macOS) / `Ctrl+Shift+X` (Windows/Linux), customizable at `chrome://extensions/shortcuts`.
- Reply translation uses CKEditor-aware paste strategies so text actually sticks (see v1.0.7 notes below).
- Translation memory: up to 2000 recent translations cached locally per browser, LRU-evicted. "Clear cache" button in the popup.
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
src/translate-core.js  Pure helpers (HTML↔markdown, URL/img tokens, blockquote split). Exposed
                       as window.__ztCore in the browser; require()-able under Node for tests
background.js          Service worker — installs defaults, dispatches keyboard shortcut
popup.html / popup.js  Toolbar popup: toggle, fallback config, cache stats, Clear cache
styles.css             UI styling — badges, toasts, language dropdown, PDF modal
lib/pdfjs/             Bundled Mozilla PDF.js (v5.6.205) — used by the in-page PDF viewer
icon*.png              Extension icons
package.json           Test harness only (jsdom devDep, node:test runner) — extension itself
                       has no Node runtime dependency
tests/                 node:test cases for the translate-core helpers
.github/workflows/     CI: runs `npm test` on every push and PR to main
INSTALLATION_GUIDE.md  End-user setup + LibreTranslate configuration
QA_CHECKLIST.md        Pre-release smoke test
ROADMAP.md             v2 work plan + post-mortems
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

### v1.0.48 (current)
- **PDF viewer now actually loads the PDF.** v1.0.47 fixed the click interception, but the modal opened blank — the viewer's UI rendered but no document. Root cause: PDF.js's bundled viewer fetches the URL from the iframe's `chrome-extension://` origin without sending Zendesk session cookies, so Zendesk's `/attachments/<token>/` redirector returned an unauthenticated response (probably an HTML login redirect, not the PDF bytes). Fix: do the fetch in the **content script** instead, where it runs in the page's context, sees Zendesk's cookies as same-origin same-domain requests, and follows the redirect to `*.zdusercontent.com` correctly. The bytes are then passed to the iframe via `postMessage` as a transferable `ArrayBuffer` (no double-memory copy for large PDFs), and a small inline bridge script in `viewer.html` listens for the message and feeds the data to `PDFViewerApplication.open({ data })` directly. The URL-based fetch path is gone — `?file=` is no longer used. Added: a centered "Loading PDF…" status overlay during the fetch window, replaced with a red error pill if the fetch or handoff fails (so blank-modal is no longer a possible end state — either the PDF renders or you see a clear failure message).

### v1.0.47
- **PDF interceptor actually intercepts now.** The v1.0.46 diagnostic logs revealed two reasons v1.0.45's interceptor missed every Zendesk attachment click:
  - **URL detection too narrow.** Zendesk's attachment URLs look like `https://<subdomain>.zendesk.com/attachments/<token>/?name=Return+label.pdf`. The path is opaque; the filename only exists in the `?name=` query parameter. `looksLikePdfUrl` was only checking the path. Fixed: now also scans every URL query value for a `*.pdf` filename.
  - **DOM scope check missed the actual attachment markup.** Field log showed `inZdComment: false, inOmniLogMessage: false` — neither selector matched the wrapper Zendesk uses for attachment links in current Omnichannel builds. Rather than chase the right selector (which Zendesk could change again), the URL pattern itself is now the trust signal: `/attachments/<token>/` on `*.zendesk.com` is unambiguously Zendesk's own attachment system, never a customer-typed link, so we trust the URL pattern alone and skip DOM ancestry checks for those. External PDF URLs (e.g. a public link pasted into a message) still go through the `.zd-comment` / `[data-test-id="omni-log-message-content"]` scope check so PDF links in the Refurbed 360 sidebar etc. keep native behavior.
- **Diagnostic `[zt-pdf]` logs left in.** Still unconditional for one more cycle so we can verify the fix actually intercepts on your end. Will move under `ztDbg.log` (or be removed entirely) once confirmed working.

### v1.0.46
- **Diagnostic build for the PDF interceptor.** v1.0.45's PDF click interceptor isn't catching attachment clicks in the field — symptom: clicking a PDF in a customer/agent message briefly opens a new tab and downloads the file via Chrome's default behavior. v1.0.46 adds unconditional `[zt-pdf]` console logs on every anchor click so we can see (a) whether the listener fires at all, (b) whether the anchor is recognized as a PDF URL, (c) what container the anchor sits in (`.zd-comment` vs the broader `[data-test-id="omni-log-message-content"]` vs neither), and (d) the full `data-test-id` ancestry up to 8 levels. The scope check is also temporarily broadened to accept either `.zd-comment` *or* `[data-test-id="omni-log-message-content"]` so we can isolate "wrong selector" from "no anchor click at all". These logs run regardless of `ztDebug` for this version only and will be quieted in the next release once the root cause is known.

### v1.0.45
- **PDF in-page viewer (Phase 3 #12 — closes Phase 3).** Click any link to a PDF inside a customer message, agent message, or internal note (anywhere in `.zd-comment`) and the PDF now opens in a fullscreen modal overlay backed by Mozilla's PDF.js viewer — no more leaving the ticket to read an attachment in a new tab. PDF.js's bundled toolbar gives text selection, page navigation, zoom, find-in-document, **download**, print, and presentation mode for free. Modal closes on Escape, click on the dimmed backdrop, or the × close button. PDF.js v5.6.205 prebuilt dist bundled at `lib/pdfjs/` (~11 MB after stripping source maps, sample PDF, and debugger module). The interceptor scopes strictly to `.zd-comment` — PDF links anywhere else (Refurbed 360 sidebar, native Zendesk fields, the requester profile, etc.) keep their default Chrome behavior. Modifier-key clicks (Cmd/Ctrl/Shift/Alt/middle-click) and right-click context menus also pass through untouched, so the agent can still open in new tab or save directly when they want to bypass the modal. Host permissions narrowed: added `https://*.zdusercontent.com/*` to `host_permissions` (rather than relying on the optional broad grant) so the install prompt is precise about why the extension needs that origin.

### v1.0.44
- **Automated tests for the markdown roundtrip (Phase 2 #11) — closes Phase 2.** Pure helpers (`htmlToMarkdownish`, `markdownishToHtml`, `protectUrls`, `restoreUrls`, `splitCommentAtFirstBlockquote`, `extractEnglishSourceFromMarkdown`, `stripMarkdownSyntax`, `escapeHtml`, `serializeNodeAsMarkdown`, `makeUrlToken`) extracted from `content.js` into a new `src/translate-core.js` with a UMD wrapper that exposes them as `window.__ztCore` in the browser and `module.exports` under Node. The manifest's `content_scripts.js` array loads `src/translate-core.js` first, then `content.js`, which destructures the helpers at the top of its IIFE — call sites stay unchanged. 44 test cases across 5 files in `tests/` cover the full HTML↔markdown roundtrip including adjacent-`<p>` lines, `<p><br></p>` sentinel, `<hr>` separator, bold/italic/underline/list fidelity, URL token protection (incl. Wikipedia-style nested parens, trailing punctuation, multi-URL ordering), `<img>` outerHTML preservation, blockquote-split (incl. nested blockquotes + post-quote signatures + ancestor-div preservation), and `extractEnglishSourceFromMarkdown` edge cases (multiple separators, trailing `---`, isolated dashes). GitHub Actions runs `npm test` on every push and PR to `main` and blocks merges when red. Locally: `npm install && npm test`. The contentMatches false-negative we hit in v1.0.42 and the override-clobber we hit in v1.0.39 are both the kind of regression these tests would have caught at PR time.

### v1.0.43
- **Ticket-wide language lock (Phase 1 #6, v1.0.34) rolled back.** Field reports surfaced two related symptoms that traced back to the lock: (1) tickets where the original language was, say, German but the extension declared the messages Finnish — the reply flag and language tag stuck on Finnish, and (2) English customer replies in tickets that were locked to a non-English language got "translated" to garbled English (round-tripped through a translator with the wrong source). Root cause: the lock saved the *first* confident detection forever, but short and ambiguous first messages (order IDs, greetings, addresses) are exactly where detection is least reliable. A single bad first guess then forced every subsequent message in the ticket through the wrong language. v1.0.40's earlier `'en'` exclusion only patched half the problem (and was itself a symptom of the same brittleness). Behavior reverts to per-message detection — each message is detected independently, results cached in `data-zt-lang` so repeat scans don't burn API calls. The ticket-wide map still exists and is *still consulted* for manual dropdown overrides (caret menu writes to it; persists across reloads as a deliberate user action), just no longer written to from auto-detection. **One-time migration on upgrade clears all existing entries** — most are stale auto-detections; agents who want to re-pin a manual override can do so in two clicks via the caret. The migration is gated by a `ztMigrations.clearTicketLockV2` flag so it runs exactly once per browser profile.

### v1.0.42
- **Root cause of the override-then-edit bug found and fixed.** The v1.0.41 diagnostic logs showed `runReplyTranslate end {ok: false}` on every translation — even short successful ones — and the toast `"Could not replace reply text — no strategy worked"` firing despite the text visually landing in the composer. The miscalibration was in `contentMatches`, the post-injection sanity check that decides whether `replaceReplyText` should report success: it normalized whitespace on both sides but never accounted for the markdown-only artifacts that don't render as text in the final HTML. Specifically:
  - `\n\n---\n\n` in the source markdown becomes a real `<hr>` element, which contributes zero `innerText`.
  - `{{ztimgN}}` tokens (Phase 2 #9) rehydrate to `<img>` tags, also zero `innerText`.
  Both leak into the `target` side of the comparison but never appear in the `current` side, so for short replies (target ≤40 chars), the substring fallback compared `"Hallo --- Hello"` against `"Hallo Hello"` and reported mismatch. Both injection strategies then dutifully reported failure, the error toast fired, `runReplyTranslate` returned `ok: false`, and the auto-retranslate `lastEnglish` marker never advanced from `''` — so every subsequent edit re-ran translation correctly *but* still flagged as failure, and never updated `lastEnglish` either, locking the cycle. Fix: strip both artifacts from the target before comparing. One-line addition to the `norm` helper. As a side effect, the false-positive `"Could not replace reply text"` toast that was appearing on most short translations is also gone.
- **Quieted the v1.0.41 `[zt-auto]` diagnostic logs.** They're now gated behind `ztDbg` like the other translator-internal logs, so console stays clean during normal use. Re-enable for future debugging via `chrome.storage.local.set({ztDebug: true})`.

### v1.0.41
- **Diagnostic build for the dropdown-override auto-retranslate bug.** v1.0.39 and v1.0.40 both attempted fixes for "after a dropdown override, editing English at the bottom doesn't refresh the top translation." Both still report the symptom in the field. v1.0.41 adds unconditional `console.log` calls (prefix `[zt-auto]`) at every guard in the auto-retranslate path plus entry/exit of `selectLanguageOverride` and `runReplyTranslate`, so the next field run produces enough console output to pinpoint exactly which guard is bailing or which call is missing. These logs run regardless of `ztDebug` for this version only — they'll be quieted in the next release once the root cause lands.
- **Phase 2 #10 (country-code → language auto-select) cancelled.** The country code lives inside Refurbed 360's iframe at `zendesk360.refurbed.com`, and same-origin policy blocks the parent-page content script from reading into a different origin. Pursuing it would require injecting into the third-party iframe (fragile against their deploys) or asking Refurbed to expose a `postMessage` API. The existing language-override dropdown covers the use case in two clicks.

### v1.0.40
- **Auto-retranslate now works after a dropdown override.** Symptom: agent picked a new language via the caret, the override translation landed, then editing the English at the bottom didn't refresh the top translation. Root cause: Zendesk's React occasionally swaps the composer's contenteditable element wholesale between translations (we observed this after a synthetic-paste injection on certain ticket types). Our `input` listener was bound directly to the original element, so events on the replacement element silently went nowhere. Fix: replaced the per-composer listener with a single document-level delegated listener installed once at `init`. It resolves the visible composer at event time via `closest()`, so it tolerates whatever DOM swaps Zendesk performs. Also covers the case where the listener was never attached because the agent typed before any first translation.
- **Reply flag no longer freezes on the English emoji on non-English tickets.** Symptom: opening certain tickets showed the English flag on the reply button even though customer messages were clearly in another language, and the dropdown was the only way to recover. Root cause: the ticket-wide language lock from Phase 1 #6 absorbs the very first detection. If the first scanned customer message happened to detect as English (short messages — numbers, addresses, greetings — round-trip to English regardless of the writer's native language), the lock froze on `'en'` and the lock is permanent by design. Fix: auto-detection no longer writes `'en'` to the lock. Subsequent customer messages get re-detected until a non-English one wins; per-message `data-zt-lang` keeps redundant API calls in check. Existing locks containing `'en'` are stripped on first load after upgrade (one-time migration).
- **English removed from the language-override dropdown.** English is the agent's native language, not a translation target.

### v1.0.39
- **Fix dropdown override getting clobbered by polling.** Symptom from the field: agent picks a new language via the caret dropdown, the reply correctly retranslates once, then on the next edit below `---` the auto-retranslate snaps back to the *original* ticket language — and stays there. Root cause: `addReplyTranslateButton()` runs every 1.5s via the poll backup and was reading `languageOfVisibleTicket()` (which scans customer messages' `data-zt-lang`) as the source of truth. Those attributes still hold the originally-detected language; they don't move when the dropdown override updates the ticket lock. Fix: the reconciliation now checks `ticketLanguages[ticketId]` first and treats it as authoritative when present, falling back to the per-message scan only when no lock has been written yet (e.g. the very first scan tick before any customer message has been processed). The dropdown override stays sticky across poll ticks, and the auto-retranslate that follows uses the override target as expected.

### v1.0.38
- **Language-override dropdown bugfixes (v1.0.36 fallout).** Four issues that surfaced once the dropdown hit real Zendesk traffic:
  - **Caret stacked under the flag instead of beside it.** The wrapper inherited `.sc-k83b6s-1.jXsvnN` from Zendesk's toolbar; that class evidently switched to `flex-direction: column` in the current Zendesk build, so our two children stacked vertically. `.zt-reply-wrapper` now forces `display: inline-flex; flex-direction: row; align-items: center` with `!important` to override Zendesk's class regardless of which way they flip it.
  - **Caret too small (read as "screen dust").** Bumped the glyph from `▾` (BLACK DOWN-POINTING SMALL TRIANGLE) at 11px to `▼` (full-size BLACK DOWN-POINTING TRIANGLE) at 13px / weight 700, with wider min-width and padding.
  - **Scrolling within the dropdown closed it.** The previous `scroll` listener was attached on `window` in capture phase, so a wheel event inside the menu's overflow region bubbled up and tripped the dismissal. Listener removed entirely. Trade-off: scrolling the Zendesk page with the menu open will leave the (fixed-position) menu visually disconnected from the caret; the agent can click outside or press Escape to close.
  - **Clicking the scrollbar closed the dropdown.** Native scrollbar mousedowns in Chrome target `document.documentElement`, not the scrolling element — so the previous `menu.contains(target)` check returned false and dismissed the menu. Replaced with a geometric `getBoundingClientRect()` check that captures the scrollbar gutter (which lives within the menu's bounding rect even though it isn't a DOM child). Switched the trigger event from `click` to `mousedown` for consistency.

### v1.0.37
- **Images preserved through translation.** Embedded `<img>` tags in customer messages and agent replies now survive the full HTML → markdown → translate → HTML roundtrip with every attribute intact (`src`, `alt`, `width`, `height`, inline `style`). Mechanism mirrors the existing URL-token protector: during serialization, each image is replaced with a `{{ztimgN}}` token while its `outerHTML` is captured into a per-call array; the token rides through the translator as plain text (Google and LibreTranslate both preserve the `{{...}}` shape verbatim, same way they preserve `{{ticket.requester.first_name}}` and `{{ztlinkN}}`); on rehydration, `markdownishToHtml(md, imgs)` swaps the tokens back to the original markup. `htmlToMarkdownish` now returns `{md, imgs}` instead of a bare string — change-detection callers extract `.md`, full-roundtrip callers thread both through. Alt text is intentionally not translated (low value to sighted users; non-zero risk of ungrammatical phrasing in the target language).

### v1.0.36
- **Language-override dropdown on the reply flag.** A small `▾` caret button now sits flush right of the flag pill. Clicking it opens a fixed-position dropdown listing every supported language with its flag — 24 entries, alphabetical by display name, scrollable, with the currently active language highlighted. Selecting one writes the choice through to the ticket-wide language lock (so future replies in this ticket default to the new language and the per-ticket lock survives reloads), updates the flag emoji, and — if the composer has English content — immediately retranslates to the new target. The menu closes on outside click, Escape, scroll, or a second click of the caret. Built as a fixed-position element appended to `<body>` rather than nested inside the toolbar so it floats above any Zendesk z-index/`overflow:hidden` layer; the menu flips upward when there's not enough room below the caret. Auto-retranslate's last-translated marker is reset on language change so the new run isn't filtered as a no-change repeat.

### v1.0.35
- **Auto-retranslate on edit below `---`.** After the first reply translation lands (composer holds `<translation>` + `---` + `<english>`), edits to the English portion now trigger an automatic retranslation 2 seconds after the agent stops typing — no need to re-click the flag. The flag button shows the same `⏳ → ✓` state it shows on a manual click. Edits *above* the separator are ignored on the assumption that the agent is fine-tuning the translation itself; deleting the `---` line entirely also stops auto-firing (the next click then treats the whole reply as fresh English source). A 2s debounce coalesces bursts of typing into one retranslate call. The reply-translation flow refactored so click and auto-fire share a single `runReplyTranslate(replyArea, triggerBtn)` core: click does its alert-driven precondition checks first, auto-fire's input filter handles the same checks silently. `inProgress` guard prevents the synthetic-paste injection from re-triggering itself.

### v1.0.34
- **Ticket-wide language lock.** Once the extension has detected the customer's language for a ticket — say ticket 3165645 is in German — every subsequent message in that same ticket skips detection entirely and uses the locked value. The lock is persisted forever in `chrome.storage.local.ticketLanguages` keyed by ticket ID, so even reopening the ticket weeks later avoids the redundant detection call. Detection precedence is now: (1) the per-message `data-zt-lang` from earlier scan ticks, (2) the ticket lock when the message is in the currently visible panel, (3) a fresh provider call. Step (2) is gated on `isElementVisible(messageElement)` because Zendesk keeps multiple tickets in the same DOM and `getTicketIdFromUrl()` only knows the active one — applying ticket A's lock to a hidden ticket B's message would mis-translate. Confident detections (anything not `'unknown'`) get written back to the map for the visible ticket; `'unknown'` results are not cached so a transient detection failure doesn't poison the lock. The Phase 2 language-override dropdown will write to this same map for manual overrides.

### v1.0.33
- **Scroll position preserved across customer-message swaps.** Toggling Show original ↔ Show translation, or the initial auto-translate swap landing while the agent has already scrolled to read further down, no longer yanks the message hundreds of pixels under the cursor when source and translation differ in length. New `preserveScrollAround(anchor, mutate)` helper records the message's viewport top before the swap, runs the mutation, and on the next animation frame adjusts the scroll position of the nearest scrollable ancestor (Zendesk's conversation log lives in a custom scrolling div, not the window) so the anchor sits at the same viewport pixel as before. Falls back to `window.scrollBy` for the rare case nothing in the chain scrolls. Sub-pixel deltas are skipped to avoid feedback loops with React re-renders.

### v1.0.32
- **Hidden diagnostic-log toggle.** Verbose `[zt]` and `[zt debug]` translator logs (cache-hit notes, "reply replaced via strategy" lines, the full reply-translation pipeline group with innerHTML/markdown/translated-output snapshots) are now off by default and gated behind `chrome.storage.local.ztDebug`. Toggle from any DevTools console: `chrome.storage.local.set({ztDebug: true})` to enable, `chrome.storage.local.remove('ztDebug')` to disable. The flag is hot-reloaded via `storage.onChanged` so no tab refresh is needed. Lifecycle messages (init/ready), warnings (`console.warn`), and errors (`console.error`) are always on — only the high-volume diagnostic stream is gated, keeping production console noise low while leaving the same logs one keystroke away when something needs investigating.
- **Rate-limit graceful degradation on Google 429.** When Google's public translate endpoint returns HTTP 429, the extension now sets a 60s cool-off instead of letting every subsequent paragraph independently re-trigger the rate-limit. During the window: `translateParagraph` skips Google and goes straight to LibreTranslate when one is configured, so the agent keeps working uninterrupted; without LibreTranslate, the call throws a typed error and the toast says "Google Translate rate-limited — wait Xs, or configure LibreTranslate fallback." `detectLanguage` mirrors the same logic. After the 60 seconds elapse, Google is silently re-tried on the next call. Implemented as a single shared `googleCooloffUntil` timestamp so a 429 triggered by detection also short-circuits the next translation, and vice versa.

### v1.0.31
- **Keyboard shortcut for reply translation.** `Cmd+Shift+X` (macOS) / `Ctrl+Shift+X` (Windows/Linux) triggers the reply-translate flag on the currently-visible ticket, the same as a click. Registered via the Manifest V3 `commands` API; agents can remap or disable it at `chrome://extensions/shortcuts` without any extension change. The background service worker catches the keypress and forwards a `shortcut-translate-reply` message to the active Zendesk tab's content script. If no non-English ticket is open (so no flag button is present), a toast explains what's missing instead of silently doing nothing. Windows default is `Ctrl+Shift+X` rather than `Ctrl+Shift+T` to avoid colliding with Chrome's built-in "reopen closed tab".

### v1.0.30
- **Cache upgrade: 20× capacity + true LRU.** `CACHE_MAX` raised from 100 to 2000 entries. v1.0.29's telemetry on two agents over 4 days showed hit rates of 79% and 86% at the old 100-entry cap — the cache was constantly evicting hot boilerplate. 2000 entries ≈ 3MB of storage, comfortably under Chrome's 5MB default quota, and leaves room for recurring templates and greetings to stay resident. Eviction is now proper LRU: every cache hit bumps the key to the end of the insertion order (via delete + reassign), so the oldest-accessed entry — not the oldest-inserted — is what falls out on the next miss.
- **Clear cache button in the popup.** Small button under the cache status row. Wipes `translationMemory` and resets the hit/total counters in `chrome.storage.local`, then broadcasts a `clearCache` message to every open Zendesk tab so their in-memory copies don't race stale values back in on the next translate call. Useful after a cache-version bump, or just to reset the hit-rate stat for measurement.
- **Debounced memory writes.** `translationMemory` writes piggy-back on the same 1s coalescing timer that already batched the `cacheStats` writes, instead of a fresh `chrome.storage.local.set` on every miss. A burst of translations on ticket load now produces a single storage write per second regardless of cache activity.

### v1.0.29
- **Cache stats persist across Chrome restarts.** The hit / total counters are now stored in `chrome.storage.local` and loaded at content-script startup, so the popup's "Cache: N entries · H/T hits (X%)" reflects lifetime behavior instead of just the current session. Writes are debounced (1s coalescing window) so a burst of translations doesn't thrash storage. Cross-tab updates are picked up via the `storage.onChanged` listener, taking the larger incoming total so no counts are lost.
- **New icon.** Replaced the basic default with a bolder, more recognizable mark: pastel teal rounded square (same colour family as the in-page language badge) with bold white "A 文" — Latin on the left, CJK on the right — that reads as "translate between languages" at a glance. Master rendered at 512x512 and downscaled with LANCZOS for 48 and 16 so the small sizes stay sharp. Generator script lives at `scripts/generate_icons.py` (macOS Pillow + system fonts) so the icons can be regenerated deterministically later if the design is tweaked.

### v1.0.28
- **LibreTranslate is now a fallback, not an alternative.** Google Translate is always primary. If a Google call throws (network, timeout, 5xx, blocked), the same paragraph is retried against LibreTranslate when a URL is configured. Fallback runs per-paragraph so a single Google hiccup in a long message doesn't force the whole message through the slower path.
- **Popup UI redesigned.** The Google/LibreTranslate radio is gone. The LibreTranslate URL + API key fields now live under a "Fallback translator (optional)" section with a hint line explaining when they're used. An empty URL means no fallback.
- **Cache key unified.** Previously keys were prefixed with the active provider (`v4:google:…` / `v4:libre:…`), which split the cache in half. v5 keys drop the provider segment — a translation is a translation, regardless of who produced it, and unifying doubles the cache hit rate in the mixed-provider case. Any `v4:` entries from before are unreachable and will naturally evict.
- **Cache stat is now a hit rate.** The popup's "Cached Translations: N" row is replaced with "Cache: N entries · H/T hits (X%)", updated live from the content script. Hit/total counters are session-scoped (reset on content-script reload), so the number reflects *current* behavior rather than lifetime history. This is the instrumentation step — once you've observed the actual hit rate, we'll decide whether to bump the 100-entry limit, keep it, or remove the cache entirely.
- **Language detection uses the same fallback chain.** Google detect first, LibreTranslate detect on failure if configured. Previously only the selected provider was used; now a Google rate-limit doesn't break auto-translate when LibreTranslate is available.
- **Legacy `provider` setting cleaned up.** Existing installs that had `provider: 'libretranslate'` in storage: the value is ignored and removed on update. LibreTranslate URL + API key are preserved (now used as the fallback).

### v1.0.27
- **Auto-translate customer messages in place of the original.** Customer messages are now translated automatically on ticket load rather than on click. The translated content is swapped into the `.zd-comment` body itself (not shown below in a separate box), so the ticket reads entirely in English by default. Matches the "Auto Translator" name at last.
- **Agent messages skipped.** Messages are identified by the `type` attribute on `[data-test-id="omni-log-item-message"]` (`end-user` vs `agent`). Agent messages are skipped entirely — no language detection, no badge, no button. They're either already in English or already bilingual (sent via the reply flow with the `---` separator).
- **Quoted email history is preserved verbatim.** If a customer's reply contains a `<blockquote>` with the previous email thread, only the content *before* the first blockquote goes through translation. The quoted part is appended unchanged after the translation, and is included in the stored original — always visible, never re-translated.
- **Toggle replaces the Translate button.** The touching badge+button row is still there, but the button is now a state toggle: "Show original" when the translated view is displayed, "Show translation" when the original is displayed. Both stored in a WeakMap keyed by the `.zd-comment` element.
- **The "ENGLISH TRANSLATION:" label stays.** Rendered as a small uppercase-spaced header directly above the translated content inside the message body, visible whenever the translated view is active. Hidden in the original view.
- **Retry on failure.** If translation fails (provider down, network error), the original stays visible, the badge gets a `⚠` suffix with a tooltip, and the button label becomes "Retry translation". Clicking retries the same call.
- **Cleanup on disable / ticket switch.** Original `.zd-comment` contents are restored before UI removal, so Zendesk's DOM is left exactly as we found it.

### v1.0.26
- **Collapse HTML formatting whitespace in text nodes.** v1.0.25's diagnostic logs on the Refurbed auto-reply showed the `\n\n` between numbered list items was in the *source* markdown, not the translator response: Zendesk's HTML has literal newlines between `</a>`, `<br>`, and `<b>` tags for readability. My serializer preserved those as real `\n` characters, so between each list item we had `\n` (from text node) + `\n` (from `<br>`) + `\n` (from text node) = three newlines → normalized to `\n\n` → paragraph break in markdown → sentinel paragraph in rehydration → visible blank line.
- Collapse runs of whitespace (including literal newlines) inside text nodes to a single space, matching how HTML renderers treat whitespace. Only `<br>` and block-level elements should produce newlines in the markdown.
- Also trim leading/trailing whitespace per line in the final markdown, so the single spaces left over at line edges (e.g. from whitespace between a `<br>` and the next tag) don't leak through.
- Cache key unchanged (`v4:`) — the serializer produces shorter but structurally equivalent input for messages without list items; for list-heavy messages the input is actually different (fewer paragraphs), so cached entries will repopulate.

### v1.0.25
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
