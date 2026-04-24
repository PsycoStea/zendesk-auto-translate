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

Small, localized changes. Each ships as its own version so the team can pull updates incrementally during this phase. No dependencies between Phase 1 items.

### 1. ⬜ Configurable keyboard shortcut for reply translate (from #1)

**Effort:** ~45 min

**Decisions:**
- Defaults: `Cmd+Shift+X` on macOS, `Ctrl+Shift+T` on Windows/Linux.
- Agent can change via `chrome://extensions/shortcuts` (Chrome's built-in customization UI — nothing to build in our popup).
- Shortcut triggers the currently-visible ticket's reply-translate flag click programmatically.

**Implementation:**
- Add `"commands"` section to `manifest.json` with `suggested_key` per platform.
- Register a handler in `background.js` that `chrome.tabs.sendMessage`s the active Zendesk tab with `{action: 'shortcut-translate-reply'}`.
- `content.js` listener triggers `findVisibleReplyButton().click()`.

**Open questions:**
- ⚠ `Ctrl+Shift+T` is Chrome's own "reopen closed tab" shortcut on Windows. Chrome extension shortcuts **do** override built-in ones, but flag this in the team's onboarding doc so they know that reopening closed tabs moves to the context menu while the extension is installed. Or we pick a different Windows default. Flagged for your decision when this item starts.

---

### 2. ⬜ Diagnostic log toggle (from #8)

**Effort:** ~30 min

**Decisions:**
- Hidden developer flag. No popup checkbox.
- Read once at content-script init from `chrome.storage.local.ztDebug`.
- Turn on via DevTools console: `chrome.storage.local.set({ztDebug: true})`.

**Implementation:**
- Wrap every `console.groupCollapsed('[zt debug]…')` call site and all `console.log('[zt] …')` translator logs in `if (ztDebug)`.
- Leave `console.error` calls untouched (errors always log).

---

### 3. ⬜ Rate-limit graceful degradation (from #7)

**Effort:** ~60 min

**Decisions:**
- On HTTP 429 from Google, mark a `googleCooloffUntil = Date.now() + 60_000` flag.
- During cool-off, `translateParagraph` skips Google and goes straight to LibreTranslate (if configured) or throws to surface the error toast.
- After 60s, Google is tried again for the next call.

**Implementation:**
- `googleTranslate`: detect `res.status === 429`, set cool-off, throw typed error.
- `translateParagraph`: check cool-off before Google call.

---

### 4. ⬜ Service worker keep-alive (from #9)

**Effort:** ~30 min — **or skip if not needed**

**Decisions:**
- Investigate first: if we're not seeing symptoms (dropped shortcut triggers, toggle commands not reaching tabs), this is premature optimization.
- If needed, add a `chrome.alarms.create('zt-keepalive', {periodInMinutes: 0.4})` that wakes the service worker every ~24s (under Chrome's 30s idle kill timer).

**Open question:** have you observed any symptoms of the background service worker being killed? (answer before starting)

---

### 5. ⬜ Preserve scroll position across toggle (from #3)

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

### 6. ⬜ Ticket-wide language lock (from #4)

**Effort:** ~45 min

**Decisions:**
- Persist forever: `chrome.storage.local.ticketLanguages = { "3165645": "de", ... }`.
- Check before calling `detectLanguage`. Cache miss → detect + store.
- Invalidation: manual override via the language-override dropdown (#5 / Phase 2) writes to this same map.

**Implementation:**
- Replace per-message `data-zt-lang` caching with a ticket-scoped lookup keyed by the ticket ID from `getTicketIdFromUrl()`.
- Migration: existing `data-zt-lang` attrs stay (they're ephemeral per-message), the ticket map just short-circuits detection when populated.

---

## Phase 2 — UX features (target: weeks 2–3)

Visible improvements agents will feel every day. No cross-dependencies inside Phase 2, but all build on Phase 1 (esp. ticket-wide language lock).

### 7. ⬜ Auto-retranslate on edit below `---` (from #2)

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

### 8. ⬜ Language-override dropdown on reply flag (from #5)

**Effort:** ~2 hours

**Decisions:**
- UI: a small `▾` caret button directly to the right of the flag pill. Click opens a dropdown menu with the supported languages (23 from our current `languageInfo` map, scrollable).
- Selection writes to the ticket-wide language lock (Phase 1 #6) — same API call immediately translates this reply and future replies in the ticket default to the new language.
- Layout: fits into the existing touching badge+button row as a third pill section, `[🇩🇪 German][Show original][▾]`.

**Open question:** should the dropdown search by typing, or is a static scrolling list enough for 23 items? (answer at implementation time)

---

### 9. ⬜ Image preservation during translation (from #12)

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

### 10. ⬜ Country-code → language auto-select on new tickets (from #14)

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

### 11. ⬜ Automated tests for markdown roundtrip (from #6)

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

## Phase 3 — Foundations (target: week 4)

### 12. ⬜ PDF in-page viewer (from #11)

**Effort:** ~5 hours

**Decisions:**
- Bundle Mozilla's PDF.js inside the extension (`lib/pdfjs/`). Adds ~2MB to the extension size; acceptable.
- Intercept click on any `<a>` inside Zendesk message bodies (`.zd-comment`) whose `href` ends in `.pdf` or whose response headers indicate `application/pdf`.
- Render the PDF in a modal overlay (not a new tab) with text selection, page navigation, zoom.
- "Download" button in the modal saves the PDF to disk (the original Chrome default behavior).
- Escape key or click-outside closes the modal.

**Open questions:**
- Zendesk's attachment URLs are on `*.zdusercontent.com`. `host_permissions` already covers `https://*/*` via `optional_host_permissions` from the LibreTranslate feature, but we'll want to request the specific host at first-use to keep the permission prompt tight.
- Scope of interception: all PDF links, or only attachments within messages (not e.g. PDFs linked in internal notes)? Answer during implementation.

---

## Phase 4 — Macro system (target: weeks 5–6)

The largest single feature. Split into three incremental releases so something ships before everything is done.

### 13. ⬜ Custom macros — local-only (from #10, v1)

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

### 14. ⬜ Macros GitHub sync (from #10, v2)

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

---

### 15. ⬜ PDF attachments as part of macros (from #13)

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

---

## Questions requiring answers before the relevant phase starts

- **(#14) DOM sample for customer sidebar** — need outerHTML of the shipping/billing address block so I can write reliable country-code selectors. Defer until Phase 2.
- **(#9) Service worker keep-alive symptoms** — have you observed dropped commands / toggle messages not reaching tabs? If no, skip this item.
- **(#1) Windows default shortcut conflict** — `Ctrl+Shift+T` overrides Chrome's "reopen closed tab". Acceptable to document in onboarding, or prefer a non-conflicting default?

---

## Out of scope for v2

Intentionally *not* shipping in v2 (parked for later):

- Team telemetry / error reporting back to a lead
- Dark mode (separate visual task)
- Copy-translation-to-clipboard button
- Translation quality indicators
- Lazy / viewport-based translation

These were considered and deliberately deferred to keep v2 scope finite.

---

## Release checklist (v2.0 GA)

Before sharing with the team:

- [ ] All 15 items above ✅
- [ ] QA checklist passes (extend existing `QA_CHECKLIST.md` with sections for each new feature)
- [ ] CHANGELOG.md generated from version history
- [ ] SETUP.md written for teammates (short, 6 steps)
- [ ] Team announcement message drafted
- [ ] Tag `v2.0.0`, not just `v1.0.30`
