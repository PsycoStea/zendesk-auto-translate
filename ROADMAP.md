# v2 Roadmap

Work items between v1.0.29 (current) and the team-wide v2.0 release.

> **Release gate:** v2.0 ships when every Phase 1–4 item is **done + QA-passed**. No partial rollout — the team gets the full feature set at once.

## Status legend

- ⬜ Planned
- 🟨 In progress
- ✅ Done
- 🚫 Cancelled / deferred

Update each item's emoji as work progresses, and the phase headers at the top of each section when a phase is fully green.

---

## Cross-cutting decisions (apply to multiple items)

| Question | Decision |
| --- | --- |
| Macros sync target repo | [`PsycoStea/zendesk-auto-translate-macros`](https://github.com/PsycoStea/zendesk-auto-translate-macros) — separate private repo. Local folder `/Users/michaelbates/Desktop/Claude Projects/Zendesk auto translate macros` |
| Macros storage format | JSON files, one macro per file, in the macros repo. PDFs co-located in `/pdfs/` subfolder |
| Macros formatting | Full rich text (bold / italic / lists / links) via the existing HTML↔markdown roundtrip |
| Macros placeholders | Zendesk-native `{{ticket.requester.first_name}}` syntax — left as literal text, Zendesk resolves at send time |
| Macro trigger UX | `//` + partial name → floating autocomplete popup anchored near caret |
| In-page PDF viewer | Bundled PDF.js (Mozilla), ~2MB one-time extension-size cost |
| Image handling | Preserve `<img>` tags at the same position via token protection, same mechanism as URLs |
| Auto-retranslate debounce | 2s after last keystroke |
| Rate-limit backoff | 60s cooldown on HTTP 429 from Google, then retry |
| Ticket language lock | Persisted forever (until ticket closed or manually overridden) |
| Automated tests | Node built-in `node:test`, run locally + via GitHub Actions on push |
| Diagnostic log toggle | Hidden developer flag (`chrome.storage.local.set({ztDebug: true})` in console) |

---

## Phase 1 — Quick wins (target: week 1)

Items resolved: #1, #2, #3, #5 shipped; #4 (service worker keep-alive) deferred until field symptoms warrant it; **#6 (ticket-wide language lock) shipped in v1.0.34 then rolled back in v1.0.43** after field reports of mis-detected tickets locking to the wrong language. See item #6 below for the full post-mortem.

Small, localized changes. Each ships as its own version so the team can pull updates incrementally during this phase. No dependencies between Phase 1 items.

### 1. ✅ Configurable keyboard shortcut for reply translate (from #1)

Shipped in v1.0.31. Windows default is `Ctrl+Shift+X` (the earlier open question about `Ctrl+Shift+T` overriding Chrome's reopen-closed-tab was resolved by picking a non-conflicting key).

**Effort:** ~45 min

**Decisions:**
- Defaults: `Cmd+Shift+X` on macOS, `Ctrl+Shift+X` on Windows/Linux.
- Agent can change via `chrome://extensions/shortcuts` (Chrome's built-in customization UI — nothing to build in our popup).
- Shortcut triggers the currently-visible ticket's reply-translate flag click programmatically.

**Implementation:**
- Add `"commands"` section to `manifest.json` with `suggested_key` per platform.
- Register a handler in `background.js` that `chrome.tabs.sendMessage`s the active Zendesk tab with `{action: 'shortcut-translate-reply'}`.
- `content.js` listener triggers `findVisibleReplyButton().click()`.

---

### 2. ✅ Diagnostic log toggle (from #8)

Shipped in v1.0.32. `chrome.storage.local.set({ztDebug: true})` enables verbose logs; `chrome.storage.local.remove('ztDebug')` disables. Hot-reloaded via `storage.onChanged` so no tab refresh required.

**Effort:** ~30 min

**Decisions:**
- Hidden developer flag. No popup checkbox.
- Read once at content-script init from `chrome.storage.local.ztDebug`.
- Turn on via DevTools console: `chrome.storage.local.set({ztDebug: true})`.

**Implementation:**
- Wrap every `console.groupCollapsed('[zt debug]…')` call site and all `console.log('[zt] …')` translator logs in `if (ztDebug)`.
- Leave `console.error` calls untouched (errors always log).

---

### 3. ✅ Rate-limit graceful degradation (from #7)

Shipped in v1.0.32. 429 from Google sets a 60s cool-off; during the window, both `translateParagraph` and `detectLanguage` skip Google and go straight to LibreTranslate (or surface a "wait Xs" toast if no fallback configured).

**Effort:** ~60 min

**Decisions:**
- On HTTP 429 from Google, mark a `googleCooloffUntil = Date.now() + 60_000` flag.
- During cool-off, `translateParagraph` skips Google and goes straight to LibreTranslate (if configured) or throws to surface the error toast.
- After 60s, Google is tried again for the next call.

**Implementation:**
- `googleTranslate`: detect `res.status === 429`, set cool-off, throw typed error.
- `translateParagraph`: check cool-off before Google call.

---

### 4. 🚫 Service worker keep-alive (from #9) — deferred

Skipped per the spec's own "or skip if not needed" guidance: the v1.0.31 keyboard shortcut and the popup's toggle / Clear-cache messages all route through the same `chrome.tabs.sendMessage` path that this keep-alive would protect, and none have shown drops in the field. Re-open this item if any of the following symptoms appear:
- Pressing the reply-translate shortcut sometimes does nothing.
- Toggling the extension from the popup leaves a Zendesk tab still translating (or vice versa).
- "Clear cache" appears to clear popup state but not the in-tab cache until reload.

**Effort:** ~30 min — **or skip if not needed**

**Decisions:**
- Investigate first: if we're not seeing symptoms (dropped shortcut triggers, toggle commands not reaching tabs), this is premature optimization.
- If needed, add a `chrome.alarms.create('zt-keepalive', {periodInMinutes: 0.4})` that wakes the service worker every ~24s (under Chrome's 30s idle kill timer).

**Open question:** have you observed any symptoms of the background service worker being killed? (answer before starting)

---

### 5. ✅ Preserve scroll position across toggle (from #3)

Shipped in v1.0.33. New `preserveScrollAround(anchor, mutate)` helper records the message's viewport position before the swap and adjusts the nearest scrollable ancestor (or the window as a fallback) on the next frame so the anchor stays at the same pixel position. Applied to both the Show original ↔ Show translation toggle and the initial auto-translate swap.

**Effort:** ~45 min

**Decisions:**
- Scope: both the customer-message toggle (Show original ↔ Show translation) and any future swap that changes message height.
- Strategy: before `innerHTML` swap, record the toggled message's top position in the viewport. After swap + repaint, adjust `window.scrollY` so the same message is at the same pixel position.

**Implementation:**
```js
const rect = messageBody.getBoundingClientRect();
const scrollOffset = rect.top;
messageBody.innerHTML = newHtml;
requestAnimationFrame(() => {
    const newRect = messageBody.getBoundingClientRect();
    window.scrollBy(0, newRect.top - scrollOffset);
});
```

---

### 6. 🚫 Ticket-wide language lock (from #4) — rolled back in v1.0.43

Shipped in v1.0.34, rolled back in v1.0.43 after field testing.

**Original implementation:** first confident detection per ticket (anything not 'unknown') was written to `chrome.storage.local.ticketLanguages` keyed by ticket ID. Subsequent messages short-circuited the locked language. Goal: save detection API calls and stabilize multi-message tickets.

**Why it was rolled back:** the lock conflated "first detection" with "ground truth," and short or ambiguous first messages (an order ID, "Hi", an address) are precisely the cases where detection is least reliable. A single bad first guess then forced every subsequent message in the ticket through the wrong language. Reported symptoms:
- English customer messages in tickets locked to a non-English language got "translated" to garbled English.
- A German ticket's reply flag stayed stuck on Finnish after one bad detection.
- v1.0.40's `'en'` exclusion only addressed half the problem.

**Replacement behavior (v1.0.43):** each customer message detects independently; per-message `data-zt-lang` cache prevents redundant API calls per message. The `ticketLanguages` map still exists, but auto-detection no longer writes to it; the caret dropdown (#8) is the only writer, so manual overrides still persist deliberately. A one-time migration on upgrade clears all existing entries.

If we want a future re-attempt, the right design would distinguish high-confidence detections (long messages, multiple corroborating samples) from low-confidence ones, and only lock on the former.

**Effort:** ~45 min

**Decisions:**
- Persist forever: `chrome.storage.local.ticketLanguages = { "3165645": "de", ... }`.
- Check before calling `detectLanguage`. Cache miss → detect + store.
- Invalidation: manual override via the language-override dropdown (#5 / Phase 2) writes to this same map.

**Implementation:**
- Replace per-message `data-zt-lang` caching with a ticket-scoped lookup keyed by the ticket ID from `getTicketIdFromUrl()`.
- Migration: existing `data-zt-lang` attrs stay (they're ephemeral per-message), the ticket map just short-circuits detection when populated.

---

## Phase 2 — UX features ✅ (target: weeks 2–3)

Items resolved: #7, #8, #9, #11 shipped; #10 (country-code → language auto-select) cancelled because the country lives inside Refurbed 360's iframe (cross-origin).

Visible improvements agents will feel every day. (Original spec assumed Phase 2 would build on Phase 1 #6 ticket-wide language lock — that lock was rolled back in v1.0.43, so the dropdown override (#8) ended up being the lone writer to `chrome.storage.local.ticketLanguages`. Detection runs per-message, dropdown writes persist, no auto-locking.)

### 7. ✅ Auto-retranslate on edit below `---` (from #2)

Shipped in v1.0.35. After the first translation lands, an `input` listener on the composer fires the existing translate-and-inject pipeline 2s after the agent stops typing — but only when the English source below the `---` actually changed. Edits above the line (the agent tweaking the translation) and edits that delete the `---` entirely don't auto-trigger; the latter just falls back to "next click translates the whole reply". Click handler refactored to call the same `runReplyTranslate(replyArea, triggerBtn)` core both paths share.

**Effort:** ~90 min

**Decisions:**
- Debounce: 2s of no keystrokes before refresh.
- Visual feedback: existing "Translating…" state on the flag button while the refresh is in flight.
- Trigger: CKEditor `input` / `keyup` events on the composer, filtered to edits that happen below the `---` separator.
- Non-trigger: no refresh when the agent edits *above* the line (they're tweaking the translation itself).

**Implementation:**
- Attach an `input` listener to the composer after first translation.
- Detect the current position of `---` in the composer; compare modified range.
- Debounced call to the existing re-translate routine.
- Gracefully handle the agent deleting the `---` line entirely: treat the whole reply as new English source on next flag click.

---

### 8. ✅ Language-override dropdown on reply flag (from #5)

Shipped in v1.0.36. `▾` caret next to the reply flag opens a fixed-position menu listing all 24 supported languages alphabetically. Selecting one writes through to the ticket-wide language lock (Phase 1 #6) and immediately retranslates the current reply if there's English content. Static scrolling list (no typeahead) — sufficient for 24 entries; the open question is resolved.

**Effort:** ~2 hours

**Decisions:**
- UI: a small `▾` caret button directly to the right of the flag pill. Click opens a dropdown menu with the supported languages (23 from our current `languageInfo` map, scrollable).
- Selection writes to the ticket-wide language lock (Phase 1 #6) — same API call immediately translates this reply and future replies in the ticket default to the new language.
- Layout: fits into the existing touching badge+button row as a third pill section, `[🇩🇪 German][Show original][▾]`.

**Open question:** should the dropdown search by typing, or is a static scrolling list enough for 23 items? (answer at implementation time)

---

### 9. ✅ Image preservation during translation (from #12)

Shipped in v1.0.37. `<img>` elements are tokenized to `{{ztimgN}}` during HTML-to-markdown serialization (capturing the full `outerHTML`); the token survives translation as plain text and the rehydrator swaps it back to the original `<img>` so all attributes (`src`, `alt`, `width`, `height`, `style`) round-trip exactly. Alt text is left untranslated by design. Applies to both customer messages and reply translation.

**Effort:** ~2 hours

**Decisions:**
- Treat `<img>` tags exactly like URLs: replace with `{{ztimg<N>}}` tokens before sending to translator, restore after.
- Keep all image attributes (`src`, `alt`, `width`, `height`, `style`) intact through the roundtrip.
- Alt text is **not** translated (low value, risk of weird phrasing in translated output).
- Applies to both customer messages (auto-translate) and reply translation.

**Implementation:**
- Extend `serializeNodeAsMarkdown` to emit `{{ztimg<N>}}` for `<img>` elements and register the `outerHTML` in a map.
- Extend `protectUrls` or add parallel `protectImages` that handles the same roundtrip.
- `markdownishToHtml` restores tokens to raw `<img>` HTML.

---

### 10. 🚫 Country-code → language auto-select on new tickets (from #14) — cancelled

Dropped from v2 scope by user decision (v1.0.41). The country code lives inside the **Refurbed 360 App** sidebar — a third-party Zendesk app whose UI runs in an iframe at `zendesk360.refurbed.com`. Same-origin policy blocks the extension's content script (running on `*.zendesk.com`) from reading inside that iframe. The only paths to extract from there would be: (a) injecting into the Refurbed iframe's origin via additional `host_permissions` and a separate content script, putting us at the mercy of Refurbed's next deploy; or (b) Refurbed exposing a `postMessage` API to the parent. Neither was deemed worth the engineering vs. the existing manual override (caret dropdown, Phase 2 #8) which handles language selection in two clicks on every ticket type.

**Effort:** ~3 hours (after DOM samples in hand)

**Decisions:**
- Watch the customer sidebar for shipping address country; fall back to billing address if shipping missing.
- Map country code → language using a static table. Unknown countries → default to English (no auto-translate).
- Multi-language countries (CH, BE, CA):
  - CH → default German, user overrides via dropdown (#8) if needed.
  - BE → default Dutch, user overrides.
  - CA → default English.
- Detected language feeds into the ticket-wide lock (#6) as the initial value.

**Open item:** need DOM sample of the customer sidebar showing the country code element. Flagged to request at implementation time.

**Country → language fallback table** (draft — review at implementation):
```
DE/AT → de
FR/MC → fr
ES → es
IT → it
NL/BE → nl
PL → pl
PT → pt
CH → de (default), fr/it overridable
DK → da
SE → sv
NO → no
FI → fi
CZ → cs
… (extend from your actual customer distribution)
```

---

### 11. ✅ Automated tests for markdown roundtrip (from #6)

Shipped in v1.0.44. Pure helpers (`htmlToMarkdownish`, `markdownishToHtml`, `protectUrls`, `restoreUrls`, `splitCommentAtFirstBlockquote`, `extractEnglishSourceFromMarkdown`, `stripMarkdownSyntax`, `escapeHtml`, `serializeNodeAsMarkdown`, `makeUrlToken`) extracted from `content.js` into `src/translate-core.js`, UMD-wrapped (browser exposes `window.__ztCore`; Node exposes `module.exports`). 44 test cases across 5 files in `tests/` cover adjacent-`<p>` round-trip, `<p><br></p>` sentinel, `<hr>` separator, formatting fidelity, URL token protection (incl. Wikipedia-style nested parens), `<img>` outerHTML preservation, blockquote-split (incl. nested + post-quote signature), English-source extraction from bilingual replies. GitHub Actions runs `npm test` on every push and PR to `main` and blocks merges when red. Local: `npm install && npm test`.

**Effort:** ~3 hours initial setup + ongoing

**Decisions:**
- Node `node:test` built-in runner (no dependencies beyond Node). Tests in `tests/*.test.js`.
- GitHub Actions workflow on push, blocks merge if red.
- Refactor `content.js` so the pure functions (`htmlToMarkdownish`, `markdownishToHtml`, `protectUrls`, `restoreUrls`, `splitCommentAtFirstBlockquote`, and — once implemented — image protection and macro placeholder handling) are exportable / importable. Use a small shim so the same file works in the browser and under Node.
- Test cases to cover (baseline):
  - Adjacent `<p>` tags roundtrip without blank lines
  - `<p><br></p>` sentinel preservation across roundtrip
  - `<blockquote>`-heavy messages split cleanly
  - URL tokens protect and restore
  - Markdown link with parens in URL (Wikipedia-style)
  - `<img>` tokens protect and restore (once Phase 2 #9 ships)

---

## Phase 3 — Foundations ✅ (target: week 4)

### 12. ✅ PDF in-page viewer (from #11)

Shipped in v1.0.45. Mozilla PDF.js v5.6.205 prebuilt dist bundled at `lib/pdfjs/` (~11 MB after stripping source maps, sample PDF, and the debugger module). Click interceptor on `document` (capture phase) catches `<a>`-with-`.pdf`-href clicks **only when the link is inside `.zd-comment`** — covers customer messages, agent messages, and internal notes; leaves PDF links elsewhere on the page (Refurbed 360 sidebar, native Zendesk fields) with their default behavior. Modifier-key clicks (Cmd/Ctrl/Shift/Alt/middle-click) and right-click context menus pass through untouched so the agent can still open in new tab or save directly. PDF.js's bundled viewer iframe gives text selection, page navigation, zoom, search, **download**, print, and presentation mode for free. Modal closes on Escape, click-outside, or the close button. Host permissions narrowed: `https://*.zdusercontent.com/*` added explicitly (rather than relying on the `optional_host_permissions: ["https://*/*"]` grant) so the install prompt is precise about why the extension needs that origin.

**Effort:** ~5 hours

**Decisions:**
- Bundle Mozilla's PDF.js inside the extension (`lib/pdfjs/`). Adds ~2MB to the extension size; acceptable.
- Intercept click on any `<a>` inside Zendesk message bodies (`.zd-comment`) whose `href` ends in `.pdf` or whose response headers indicate `application/pdf`.
- Render the PDF in a modal overlay (not a new tab) with text selection, page navigation, zoom.
- "Download" button in the modal saves the PDF to disk (the original Chrome default behavior).
- Escape key or click-outside closes the modal.

**Resolved at implementation:**
- Host permissions: added `https://*.zdusercontent.com/*` to `host_permissions` (narrow grant), not via the broader `optional_host_permissions: ["https://*/*"]` fallback.
- Scope: PDF links inside `.zd-comment` only — customer/agent messages and internal notes. PDF links elsewhere keep native browser behavior.

---

## Phase 4 — Macro system (target: weeks 5–6)

The largest single feature. Split into three incremental releases so something ships before everything is done.

### 13. ✅ Custom macros — local-only (from #10, v1)

Shipped in v1.0.52. Storage at `chrome.storage.local.macros` keyed by macro name. Settings page at `macros.html` (opened via the popup's "Manage macros…" button) provides a contenteditable rich-text editor with bold/italic/underline/list/link/unlink/clear toolbar, save/delete, filter-as-you-type sidebar list, Cmd-S save shortcut, and unsaved-changes guard on tab close. Composer-side: `//partial` typed in the Zendesk reply composer opens a dropdown anchored at the caret, filtered by substring with prefix matches first. Arrow keys navigate, Enter / Tab / mouse-click commits, Escape dismisses. Selection replaces the `//partial` fragment via the same synthetic-paste pipeline reply translation uses, so CKEditor accepts the HTML and formatting roundtrips correctly. Zendesk placeholders (`{{ticket.requester.first_name}}` etc.) pass through verbatim. Cross-tab edits flow into the running autocomplete via `storage.onChanged`.

Resolved open questions:
- **Prefix conflicts:** prefix matches first, then alphabetical. (Most-recently-used left for a v2 enhancement once we have field signal on whether it's actually noticed.)
- **Nested macros:** not supported. The macro body is inserted verbatim; no recursive `//macro` expansion.

**Effort:** ~10 hours

**Decisions:**
- Storage: `chrome.storage.local.macros = { name: { body: "<html>", attachments: [] }, … }`.
- Separate settings page (`macros.html`) for creating/editing — the popup is too small for a rich-text editor. Opened via a "Manage macros" button in the popup.
- Rich-text editor in the settings page: a lightweight contenteditable div + basic toolbar (bold / italic / list / link) — no heavy dependency.
- Placeholders: `{{ticket.requester.first_name}}` etc. are **not resolved** by the extension. They're inserted as-is into the reply composer; Zendesk handles substitution at send time.
- `//` trigger: content script listens for `input` events on the composer, detects the `//<partial>` pattern at the current caret position, shows an autocomplete popup anchored near the caret.
- Dropdown filters macros by substring match on name. Arrow keys + Enter, or click, to select.
- On selection: replace the `//<partial>` fragment with the macro body via synthetic paste (same mechanism reply translation uses). Translation and formatting roundtrip happens the same way as for typed replies.

**Open questions:**
- Conflict when two macros match the same prefix — default to most-recently-used first? Alphabetical? Answer at implementation time.
- Can a macro include another macro (nested expansion)? Default: no, keeps it simple.

---

### 14. ✅ Macros GitHub sync (from #10, v2) — shipped v1.0.61

**Effort:** ~5 hours

**Decisions:**
- Separate private repo: `PsycoStea/zendesk-auto-translate-macros`.
- Sync mechanism: GitHub API via user's Personal Access Token (stored in `chrome.storage.local`, not synced).
- Two-way sync:
  - **Pull:** "Sync from GitHub" button pulls all macro JSON files and updates local storage. Server wins on conflict — local edits are overwritten, with a confirmation prompt listing what would change.
  - **Push:** "Push to GitHub" button commits local macros to the repo via `PUT /repos/.../contents/{path}` with a message like "Update macro: refund". Each macro is its own file for clean diffs.
- On first use the popup prompts for the PAT.
- Auto-sync-on-change: optional toggle in settings. If off, sync is manual only.

**Open questions:**
- Should we use gh CLI via native messaging instead of the GitHub REST API? Probably no — REST API keeps the extension self-contained.
- What happens when an agent edits a macro and the PAT is invalid/expired? Toast + surface in popup.
- Deletion: deleting a macro locally pushes a file delete. Confirm with a prompt since it's destructive to other agents.

**As-built deviations from plan:**
- **Repo is public, not private.** Decision: macros only contain customer-facing language (greetings, signatures, return-policy text) that's already going out via email. Public lets pull be anonymous (no token, no GitHub account) for everyone — only the team lead needs a PAT to push.
- **Pull is anonymous, push is admin-only.** The split-read/write architecture removes all friction for teammates; they click Pull and it works with zero setup. Only the admin curates and publishes.
- **No automatic sync toggle.** Push and Pull are explicit buttons only. Auto-sync was deferred to avoid surprise overwrites of unpublished local edits.
- **Repo hardcoded to `PsycoStea/zendesk-auto-translate-macros`** rather than configurable, per user request — keeps the UI simpler.
- **Pull uses content-equivalence, not timestamps** (changed in v1.0.66). Comparing local body+attachments metadata against remote skips identical macros and overwrites differing ones, so a local "delete a PDF and click Pull" intuitively restores it instead of being suppressed by last-write-wins.

---

### 15. ✅ PDF attachments as part of macros (from #13) — shipped v1.0.62 → v1.0.66

**Effort:** ~5 hours (after macros + PDF viewer working)

**Decisions:**
- Macro JSON extended: `{ body: "...", attachments: ["missing-parcel-affidavit.pdf"] }`.
- PDFs live in `/pdfs/` in the macros repo, pulled in the sync step.
- Extension keeps the PDFs in `chrome.storage.local` as base64 blobs, or in IndexedDB for size. IndexedDB is better for binary; storage.local has a per-key 8KB limit that a PDF easily exceeds.
- When a macro with an attachment is selected, the extension programmatically attaches the PDF to the Zendesk composer via a synthesized `drop` event with a constructed `DataTransfer` containing a `File` object — same technique the synthetic-paste reply translation uses.
- Fallback if synthesized drop fails: show a toast with "Attachment: missing-parcel-affidavit.pdf — drag from here to attach" and let the agent do it manually.

**Open questions:**
- Zendesk's attachment upload has its own API. Is there a cleaner route via the Apps Framework? Probably not available from a regular content-script extension — stick with synthesized drop.
- Max PDF size? Zendesk has a 50MB attachment limit; extension's IndexedDB easily handles that.

**As-built deviations from plan:**
- **Storage is `chrome.storage.local` with `unlimitedStorage`, not IndexedDB.** Blobs are kept as base64 in `chrome.storage.local.macroAttachments` keyed by id. Reason: content scripts can read `chrome.storage.local` directly, so the macro-insertion path doesn't need a service-worker round-trip to fetch blobs. Base64's 33% inflation is acceptable; PDFs in macros are typically a few hundred KB.
- **Insertion uses the file-input upload path, not synthesized drop.** First attempt (v1.0.63) dispatched a synthetic `drop` on the composer area, which triggered Zendesk's "Drop to Attach" overlay because the `dragenter` showed it but our `drop` didn't fire on the overlay's actual drop zone — leaving the overlay stuck. v1.0.64 switched to finding Zendesk's hidden `<input type="file" data-test-id="omnicomposer-external-file-uploader">`, setting `input.files = dataTransfer.files`, and dispatching `change`. This is exactly what a real "Attach" button click produces, so React/Lotus state updates correctly. Document-level `drop` on `document.body` (without `dragenter`/`dragover`) remains as a fallback for layouts where the file input isn't present.
- **Repo layout: per-macro folder with original filenames.** `macros/<name>/<filename>.pdf` rather than the originally-planned single `/pdfs/` folder. Per-macro folders make the GitHub UI more navigable and avoid collisions when two different macros happen to ship a `return-form.pdf`.
- **Hard cap 10MB / soft warn 2MB.** PDFs under 2MB add silently; 2-10MB prompts confirm; over 10MB rejected. Per-PDF, not per-macro.

---

## Phase 5 — Post-v2.0 patches (emergent from field testing)

Items 16–22 weren't on the original v2 plan — they came out of using the v2.0.0 build in real tickets, where the macro/sync/attachment work surfaced edge cases and small UX gaps. Each shipped as a v2.0.x patch.

### 16. ✅ Hyperlink corruption when link text equals href (v2.0.7 / shipped under v2.0.0 commit)

**Symptom:** agent pasted a bare URL into the reply, Zendesk auto-wrapped it as `<a href="URL">URL</a>`, translation produced an `<a>` whose `href` was the literal `{{ztlink0}}` token. When the message was sent, the browser resolved that as relative to the current page (e.g. `https://refurbed-merchant.zendesk.com/{{ztlink0}}`), breaking the link.

**Root cause:** in `src/translate-core.js`'s `protectUrls`, after the markdown-link regex tokenized the link as `[https://example.com]({{ztlink0}})`, the bare-URL regex's character class `[^\s<>"'\``]+` didn't exclude `]`, `)`, `}` — it over-captured into the brackets/token, producing `[{{ztlink1}})`.

**Fix:** tightened the bare-URL char class to `[^\s<>"'\``\])}]+` so it stops at markdown-link/token boundaries. Two regression tests added (`tests/url-protection.test.js`).

### 17. ✅ Cache key collisions (v2.0.0 commit)

**Symptom:** agents reported translations coming back from cache as the wrong sentence — e.g. "I have reached out to the courier to find out more as to what is happening with the delivery of your parcel" returning German for "...your order. We'll keep you updated...".

**Root cause:** the cache key was constructed as `${CACHE_VERSION}:${text.slice(0, 100)}_${targetLang}` — only the first 100 characters of the source were used. Any two messages sharing a 100-char prefix collided and returned the same translation. The truncation was a defense against an imagined storage-size concern that never materialized.

**Fix:** use the full source text as the key. Cache version bumped from `v5` to `v6` so polluted entries are unreachable and evict naturally.

### 18. ✅ Cursor position marker for macros (v2.0.1, refined v2.0.4)

**Why:** templates like `Hi {{name}}\nThanks for the email\n\n[blank]\n\nRegards,\nMac Group` always landed the caret at the end of the inserted block; agents had to manually arrow up three lines to start typing.

**Solution:** macro authors place a `{{cursor}}` marker (toolbar button: ↳ Cursor) in the macro body where they want the caret. After paste, the extension finds the marker, removes it, and parks the caret there.

**Implementation note:** the first cut (v2.0.1) tried direct text-node `data` mutation; CKEditor 5's MutationObserver reverted it. v2.0.2 tried `execCommand('delete')` — returned `true` but no-op'd in CKEditor's back-compat layer. v2.0.4 final: dispatch a `beforeinput` event with `inputType: 'deleteContentBackward'`, which is the actual event CKEditor's delete plugin listens for. Three-tier fallback (beforeinput → empty paste → DOM splice) for robustness against future Lotus changes.

### 19. ✅ Auto-translate per macro (v2.0.4)

**Why:** macros for non-English customers were inserted in English, then the agent had to manually click the translate flag every single time. Wasted seconds per ticket × hundreds of tickets per week.

**Solution:** per-macro toggle "Auto-translate after insertion" in the macros editor. When on, after the macro pastes, the existing `runReplyTranslate` flow fires automatically — composer becomes `[translated]\n\n---\n\n[english]`.

**Cache integration:** the v6 full-text cache is keyed by source text + target language, so the same macro body translated to the same language is an instant cache hit on every later insertion. Macros and the cache work hand-in-hand: canned text translates once, then it's free forever (until the macro body changes).

**Sync:** `autoTranslate` field added to the per-macro JSON; the content-equivalence check in pull merges also compares the toggle. Macros with auto-translate on have `{{cursor}}` stripped before paste (the marker is moot when the body gets rewritten by translation).

### 20. ✅ Pull merge fix: content-equivalence instead of timestamps (v1.0.66 / shipped under v2.0.0 commit)

**Symptom:** field repro from initial v2.0.0 testing — delete a PDF locally, click Save (local `updated` jumps ahead of remote), click Pull. PDF didn't come back.

**Root cause:** last-write-wins by timestamp suppressed the pull because local was "newer" by milliseconds.

**Fix:** pull now compares local body + attachments metadata directly against remote. Identical → skip; different → take remote. Local-only macros (not on remote) are still preserved untouched. Trade-off: unpushed local edits get overwritten by Pull, which matches the "Pull = take what's on GitHub" mental model.

### 21. ✅ Modern popup with light + dark mode (v2.0.5)

**Why:** adding the "Manage macros…" button after Phase 4 #13 made the popup taller than Chrome's popup window — users got a vertical scrollbar. Existing styling was also dated (hard borders, large paddings, single-theme).

**Done:**
- CSS variables for all colors with `@media (prefers-color-scheme: dark)` override. `color-scheme: light dark` so form controls and scrollbars also follow the theme.
- Compact layout — 320px width, smaller paddings, fits on screen without a scrollbar.
- Fallback translator section moved into a collapsed `<details>` (auto-expands when one is configured).
- Replaced the wide "Clear cache" button with a tiny inline button on the cache row.
- `generate_icons.py` now produces both light (pastel-teal bg) and dark (deep-teal bg, pastel-teal text) icon variants for 16/48/128.
- Manifest gains `theme_icons` so Chrome's toolbar icon follows the user's browser theme.
- Popup header swaps icons via CSS `prefers-color-scheme`.

(This invalidates the "Dark mode" item in the original "Out of scope for v2" list — it shipped here.)

### 22. ✅ Cache row layout fix (v2.0.6)

**Symptom:** at 320px popup width, the cache value `10 entries · 12/22 hits (55%)` wrapped to two lines and broke the "Clear" button alignment.

**Fix:** restructured the row as a 3-column flex (label, value, button) with `flex: 1 1 auto` + `nowrap` on the value. Tightened the format string to `10 entries · 55% hit` so it fits on one line at typical sizes. Raw `12/22 hits` ratio dropped — the percentage is the actually-useful number, raw counts only matter for diagnostics and remain in `chrome.storage.local`.

---

## Questions requiring answers before the relevant phase starts

(All answered. Section retained for archival reference.)

---

## Out of scope for v2

Intentionally *not* shipping in v2 (parked for later):

- Team telemetry / error reporting back to a lead
- Copy-translation-to-clipboard button
- Translation quality indicators
- Lazy / viewport-based translation

(Originally also listed: dark mode. Promoted into scope and shipped in v2.0.5.)

---

## Release checklist (v2.0 GA)

Before sharing with the team:

- [x] All 15 Phase 1–4 items ✅
- [x] Tagged on GitHub: `v2.0.0` (initial v2 release) and `v2.0.6` (latest patch)
- [x] README rewritten for v2 (no version-history section; "What's new since v2.0" summary added)
- [ ] QA checklist passes (extend existing `QA_CHECKLIST.md` with sections for each new feature)
- [ ] CHANGELOG.md generated from version history
- [ ] SETUP.md written for teammates (short, 6 steps)
- [ ] Team announcement message drafted

(Final three items remain open — distribution is currently manual via zip; the team lead has the v2.0.6 build.)
