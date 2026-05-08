# QA Checklist — Zendesk Auto Translator

A manual test playbook to run before each release. Covers every user-facing feature plus the edge cases that have caused regressions before.

**Last full pass:** _(date)_  
**Version under test:** _(e.g. v2.0.7)_  
**Browser / OS:** _(e.g. Chrome 130 / macOS 14.5)_

---

## How to run

- **Time:** ~40 min for a full pass. Each section is independently runnable, so you can do it across two coffee breaks.
- **Where:** real production Zendesk, the extension loaded unpacked in your primary Chrome profile.
- **Safety rule:** **all reply tests use the Internal Note tab**. Never click "Submit as Public Reply" while running this checklist — there's no sandbox and nothing in here should reach a customer. If a test seems to require a public reply to verify, mark it as skipped and tell me about it.
- **Prerequisites before starting:**
  - You have a non-English ticket open in Zendesk (any will do — even a closed one is fine for testing).
  - You have access to the macros repo (https://github.com/PsycoStea/zendesk-auto-translate-macros) and a fine-grained PAT in hand for push tests.
  - You have any small PDF file ready (under 2 MB).
  - You have any larger PDF file ready (between 2 and 10 MB) for the warn test, OR you can skip that one.
  - LibreTranslate is configured in the popup.
  - **Diagnostic logging on:** open any Zendesk tab DevTools console and run `chrome.storage.local.set({ztDebug: true})`. Hard-refresh the tab. This makes the `[zt-...]` logs visible so failures are easier to capture.

## How to record results

Tick the checkbox after each test. If something fails, write a short note on the **Notes** line below it (one line is fine — what went wrong, any console error, screenshot reference). At the end of the pass, **paste the entire marked-up file back into the chat** (or commit it; either works) and I'll triage from there.

If a whole section is broken or you want to skip something, write `SKIP: <reason>` on its Notes line and move on.

## What to capture on a failure

For any test that fails, note:

1. The exact test number (e.g. **3.4**).
2. What you actually saw vs. expected.
3. Any **`[zt-…]`** log output from the Zendesk tab DevTools console (just the relevant lines — copy/paste 5-10 lines around the failure).
4. (Optional) A screenshot path on disk if visual.

---

## Known fragile areas (informational)

These are the parts of the codebase most likely to break against a Zendesk update or in unusual usage. Tests in this checklist target them specifically — if you see a regression cluster here, that's what to expect:

- **Macro autocomplete trigger detection** — depends on contenteditable text-node selection state, which Zendesk's CKEditor 5 manages. Sensitive to where exactly the caret sits.
- **Synthetic paste into CKEditor 5** — used for both macro insert and reply translation. Timing-sensitive; CKEditor's MutationObserver can revert direct DOM mutations.
- **Cursor marker delete** — three-tier fallback (`beforeinput` → empty paste → DOM splice). If beforeinput stops working, the fallbacks should kick in but each is one more thing to verify.
- **PDF attachment file-input upload** — depends on Zendesk's `data-test-id="omnicomposer-external-file-uploader"` private contract. If they rename it, attachments fall back to drop event.
- **Customer-language detection on first message** — short / boilerplate messages can detect as English, which would skip translation. Verifies: open a non-English ticket and the first customer message gets a non-English flag.

---

# Setup phase (5 min — first run only)

If you've already done the macro setup and your repo has the test macros, you can skip this and start at Section 1.

## S.1 Verify version

- [PASS] Open the popup. Confirm it reads `v2.0.6` (or whichever version you're testing).
- **Notes:**

## S.2 Create test macros

You'll create four macros to exercise the macro feature surface across the rest of the playbook. Click **Manage macros…** in the popup, then for each:

### S.2.1 `qa-greeting` (cursor marker, no translate, no PDF)

- [PASS] Click **+ New**, name `qa-greeting`.
- [PASS] In the body, type:
    ```
    Hi {{ticket.requester.first_name}}
    Thanks for reaching out
    
    
    
    Regards,
    QA Test
    ```
    (Two Enters between "reaching out" and the next blank, two more before "Regards,". So you have one blank line between the greeting and the cursor row, and one blank line between the cursor row and the signature.)
- [PASS] Place your cursor on the empty middle line. Click the **↳ Cursor** toolbar button. The text `{{cursor}}` should appear there.
- [PASS] Auto-translate toggle: **off**.
- [PASS] No attachments.
- [PASS] Click **Save**.
- **Notes:**

### S.2.2 `qa-formatted` (rich formatting, no translate, no PDF)

- [PASS] Click **+ New**, name `qa-formatted`.
- [PASS] In the body, paste this and apply formatting via the toolbar:
    ```
    Hello,
    This is BOLD, ITALIC, and UNDERLINED text.
    Visit our help center: https://example.com
    
    - Item one
    - Item two
    - Item three
    ```
    Make "BOLD" bold, "ITALIC" italic, "UNDERLINED" underlined, and turn `https://example.com` into a real link via the 🔗 Link toolbar button (link text `help center`, URL `https://example.com`). Make "Item one/two/three" a bulleted list via the • List button.
- [PASS] Auto-translate toggle: **off**.
- [PASS] No attachments.
- [PASS] Click **Save**.
- **Notes:**

### S.2.3 `qa-translated` (auto-translate on)

- [PASS] Click **+ New**, name `qa-translated`.
- [PASS] Body:
    ```
    Thank you for your patience while we investigated this issue. We have resolved the problem and you should now see the expected behavior.
    ```
- [PASS] Auto-translate toggle: **on**.
- [PASS] No attachments.
- [PASS] Click **Save**.
- **Notes:**

### S.2.4 `qa-with-pdf` (small PDF attached)

- [PASS] Click **+ New**, name `qa-with-pdf`.
- [PASS] Body:
    ```
    Please find the requested form attached.
    ```
- [PASS] Click **+ Add PDF**, pick a small (<2 MB) PDF.
- [PASS] Auto-translate toggle: **off**.
- [PASS] Click **Save**.
- **Notes:**

## S.3 Push the test macros to GitHub

- [PASS] Click the **Settings ▾** button next to the GitHub sync bar at the top.
- [PASS] Paste your fine-grained PAT and click **Save token**.
- [PASS] Click **⬆ Push**.
- [PASS] Status pill should read `Pushed — 4 added · 1 att uploaded.` or similar.
- [PASS] Open https://github.com/PsycoStea/zendesk-auto-translate-macros/tree/main/macros — verify all four `*.json` files are there, plus the `qa-with-pdf/` folder containing the PDF.
- **Notes:**

---

# Section 1: Smoke & popup (5 min)

## 1.1 Popup loads in light mode

- [PASS] Set your OS / Chrome to **light mode** (System Settings → Appearance on macOS).
- [PASS] Click the extension icon. The popup should open with a light background, dark text, pastel-teal icon in the header.
- [PASS] No vertical scrollbar should be present.
- **Notes:**

## 1.2 Popup loads in dark mode

- [PASS] Switch OS / Chrome to **dark mode**.
- [PASS] Open the popup again. Background should switch to dark, text should be light, header icon should switch to deep-teal variant. Toolbar icon (in Chrome's toolbar) should also switch (deep-teal background).
- [PASS] No vertical scrollbar.
- **Notes:**

## 1.3 Toolbar icon theme

- [PASS] Confirm the Chrome toolbar icon visually matches the current theme (light variant on light Chrome, dark variant on dark Chrome).
- [PASS] **Retest after v2.0.7:** the toolbar icon now updates via JS (popup + content scripts report `prefers-color-scheme` to the background SW, which calls `chrome.action.setIcon`). The icon updates next time the popup opens or any Zendesk tab loads or you change theme while a Zendesk tab is open. There may be a brief delay (1–2s) on first switch.
- **Notes:**

## 1.4 Enable / disable toggle

- [PASS] Open the popup, click the **Enable translator** toggle off. Status indicator goes from green to red, label changes from "Active" to "Disabled".
- [PASS] Switch to a Zendesk tab. Customer messages should NOT have translation badges/buttons. Reply toolbar should NOT have the translate flag.
- [PASS] Re-enable from the popup. Translation UI should reappear on existing messages.
- **Notes:**

## 1.5 Cache row layout

- [PASS] In the popup, the Cache row should fit on one line: `Cache · NN entries · NN% hit  [Clear]`. No wrapping. No overflow.
- [PASS] Click **Clear**. Cache count should reset to 0; the button briefly shows "Cleared ✓".
- **Notes:**

## 1.6 LibreTranslate settings save

- [PASS] In the popup, expand the **Fallback translator (LibreTranslate)** section. Your saved URL should be in the field.
- [PASS] Click **Save settings** (without changing anything). The pill should show "Saved." in success-green for a few seconds.
- **Notes:**

## 1.7 Manage macros button

- [PASS] Click **Manage macros…**. A new tab should open at `chrome-extension://…/macros.html`. The popup should close.
- [PASS] The macros editor tab should reflect the same theme (light/dark) as the popup did.
- [PASS] **Retest after v2.0.7:** dark mode added to `macros.css` via `@media (prefers-color-scheme: dark)`. Header, sync bar, sidebar, editor, toolbar, attachment chips, and all buttons should follow the OS theme.
- **Notes:**

---

# Section 2: Translation core (10 min)

For this section, open a non-English customer ticket. **Use the Internal Note tab for any reply tests.**

## 2.1 Customer message auto-translates

- [PASS] Open a ticket whose first customer message is in a non-English language.
- [PASS] After the page loads, the customer message should show:
  - A small flag/language badge (e.g. 🇩🇪 German).
  - A button reading "Show original" (since translation is now showing by default).
  - The body should appear in English under an "ENGLISH TRANSLATION:" label.
- **Notes:**

## 2.2 Toggle Show original / Show translation

- [PASS] Click "Show original" — message body returns to the customer's language. Button label changes to "Show translation".
- [PASS] Click "Show translation" — translates back. Button label changes back to "Show original".
- [PASS] No yank or scroll-jump while toggling (regression for v1.0.33).
- **Notes:**

## 2.3 Quoted email history preservation

- [PASS] Find a customer message that contains a quoted email history (a `<blockquote>` of a previous email thread). If you don't have one, skip.
- [PASS] Confirm that only the part **before** the blockquote is translated. The quoted history should remain in the original language, untouched.
- **Notes:**

## 2.4 Customer message hyperlinks preserved

- [PASS] Find or open a customer message that contains a hyperlink (e.g. tracking URL, support article link). If none, skip.
- [PASS] After translation, the link is still clickable and points to the same URL. Hover, see the URL in the status bar.
- **Notes:**

## 2.5 Customer message images preserved

- [PASS] Find a customer message with an embedded image (screenshot, signature graphic). If none, skip.
- [PASS] After translation, the image is still visible at the same position.
- **Notes:**

## 2.6 Reply translation, plain text

- [PASS] In the Internal Note tab, type: `Thank you for your message. We are looking into this and will respond shortly.`
- [PASS] Click the translate flag in the reply toolbar (or press `Cmd+Shift+X` / `Ctrl+Shift+X`).
- [PASS] After ~1-2s, the composer should show:
  - The translation in the customer's language at the top.
  - A `---` separator.
  - Your original English below.
- [PASS] The flag button briefly shows ⏳, then ✓.
- **Notes:**

## 2.7 Reply translation, formatted

- [PASS] Clear the internal note. Paste this and apply formatting:
    ```
    Hello,
    
    Please see the BOLD update below:
    
    - Item A
    - Item B
    
    Visit example.com for more.
    ```
    Make "BOLD" bold and "example.com" a real link to `https://example.com`.
- [PASS] Click the translate flag.
- [PASS] In the translated portion, formatting should be preserved: **bold**, bullet list, hyperlink with correct `href` (hover to verify it points to `https://example.com`, NOT `{{ztlink0}}` or relative).
- [PASS] In the English portion below `---`, formatting should also be preserved.
- **Notes:**
I got an error toast that said "could not replace reply text - no strategy worked" even though the reply was translated and formatted correctly with correct hyperlink

## 2.8 Auto-retranslate on edit

- [PASS] With the bilingual reply still in the composer (from 2.7), edit the English portion below `---`. Add the word `urgent` somewhere.
- [PASS] Wait 2-3 seconds without typing.
- [PASS] The translation at the top should refresh to include the equivalent of "urgent" in the customer's language. The flag briefly shows ⏳ then ✓ during the refresh.
- **Notes:**
I got an error toast that said "could not replace reply text - no strategy worked" even though the reply was translated and formatted correctly with correct hyperlink

## 2.9 Translation cache hit

- [PASS] Clear the internal note completely.
- [PASS] Type the EXACT same sentence as in 2.6 — `Thank you for your message. We are looking into this and will respond shortly.`
- [PASS] Click the translate flag.
- [PASS] Translation should be near-instant (no perceptible network delay). Open the popup — the cache hits counter should have ticked up by 1.
- **Notes:**

---

# Section 3: Macros editor (5 min)

Skip this section if you're confident the editor is fine; otherwise it catches macro-data-corruption issues.

## 3.1 Edit existing macro persists

- [PASS] Open Manage Macros, click `qa-formatted`, change one word in the body, click **Save**.
- [PASS] Click `qa-greeting`, then back to `qa-formatted`. The change should be there.
- **Notes:**

## 3.2 Discard prompt on unsaved changes

- [PASS] Click `qa-greeting`, type any character in the body, click `qa-formatted` in the sidebar.
- [PASS] A "You have unsaved changes. Discard them?" prompt should appear.
- [PASS] Click "Cancel" — should stay on `qa-greeting`.
- [PASS] Try again, this time click "OK" — should switch to `qa-formatted` without saving.
- **Notes:**

## 3.3 Cursor button refuses to insert a second marker

- [PASS] Open `qa-greeting`. Click the **↳ Cursor** button again (a marker is already in the body).
- [PASS] Status should briefly show "This macro already has a cursor marker." No second marker added.
- **Notes:**

## 3.4 Add second PDF, then remove

- [PASS] Open `qa-with-pdf`. Click **+ Add PDF**, pick a different PDF. Click **Save**.
- [PASS] Re-open the macro — both PDFs should be in the list.
- [PASS] Click the ✕ on the second one. Click **Save**.
- [PASS] Re-open — only the original is left.
- **Notes:**

## 3.5 File picker filters to PDFs

- [PASS] Open `qa-with-pdf`. Click **+ Add PDF**.
- [PASS] In the file picker, verify only PDF files are selectable (other file types are greyed out or hidden). The `accept="application/pdf"` attribute on the input drives this.
- [PASS] Cancel the picker.
- [PASS] On macOS / Chrome, this is enforced by the OS file picker — non-PDFs cannot be chosen at all. The defense-in-depth check inside the JS (which surfaces "not a PDF (skipped)" status) only runs if a non-PDF gets through, e.g. via drag-drop on platforms where the picker is more permissive.
- **Notes:**

## 3.6 Warn on large PDF (optional)

- [SKIPPED] If you have a PDF between 2 and 10 MB, click **+ Add PDF** and pick it.
- [SKIPPED] A confirm dialog should appear warning about size. Click Cancel — attachment is not added.
- [SKIPPED] If you don't have such a PDF, write SKIP.
- **Notes:**

---

# Section 4: Macros in Zendesk (10 min)

Open a non-English ticket, switch to the Internal Note tab.

## 4.1 `//` opens the autocomplete menu

- [PASS] In the empty internal note, type `//`. A dropdown should appear at the caret showing all four `qa-*` macros (sorted alphabetically by default).
- [PASS] Press **Escape**. Menu closes.
- **Notes:**

## 4.2 Type to filter

- [PASS] Type `//formatted`. Menu should narrow down to just `qa-formatted` as you type.
- [PASS] Type a character that doesn't match any macro (`x`). Menu should still be visible but show "No macros match …".
- [PASS] Press Backspace until you're back to `//`. All four should reappear.
- [PASS] Delete the `//` entirely. Menu should disappear (regression for the v2.0.x cursor-marker work).
- **Notes:**

## 4.3 Arrow keys + Enter inserts

- [PASS] Type `//`, then press **Down arrow** to highlight the second item, press **Enter**.
- [PASS] Macro inserts. The `//` should be gone (no leftover trigger).
- **Notes:**

## 4.4 Click to insert

- [PASS] Clear the composer. Type `//`. Click on `qa-greeting` in the menu.
- [PASS] Macro inserts. `//` is gone.
- **Notes:**

## 4.5 `qa-greeting` cursor marker lands correctly

- [PASS] After inserting `qa-greeting` (from 4.4), the caret should be sitting on the blank line **between** "Thanks for reaching out" and "Regards, QA Test". Type a single letter — it should appear there, NOT after "QA Test".
- [PASS] No `{{cursor}}` literal text should be visible anywhere.
- **Notes:**

## 4.6 `qa-formatted` formatting roundtrips

- [PASS] Clear the composer. Type `//formatted` and Enter.
- [PASS] Verify in the inserted body:
  - "BOLD" appears bold
  - "ITALIC" appears italic
  - "UNDERLINED" appears underlined
  - "help center" is a hyperlink — hover to verify `href="https://example.com"` (NOT `{{ztlink0}}`).
  - Bullet list renders with bullets, not as plain text.
  - Blank lines between sections are visible (regression for the spacing-sentinel work in v1.0.60).
- **Notes:**

## 4.7 `qa-translated` auto-translate fires

- [PASS] Clear the composer. Type `//translated` and Enter.
- [PASS] The macro body should briefly appear in English, then within 1-2s the composer should show the bilingual `[translated]\n\n---\n\n[english]` format.
- [PASS] The flag button shows ⏳ then ✓ during the auto-translate.
- **Notes:**

## 4.8 `qa-translated` cache hit on second insert

- [PASS] Clear the composer. Type `//translated` and Enter again.
- [PASS] Auto-translate should be near-instant this time (the macro body is the same, the cache hits). Pop open the popup — cache hits should have ticked up.
- **Notes:**

## 4.9 `qa-with-pdf` attaches the PDF

- [PASS] Clear the composer. Type `//with-pdf` and Enter.
- [PASS] Macro body inserts. **Within 1-2s**, an attachment chip with the PDF filename should appear below the composer (Zendesk's attachment area). It should show the upload progress and complete.
- [PASS] No "Drop to Attach" overlay should appear (regression for the v1.0.64 file-input fix).
- [PASS] Click the attachment to open it — should show the PDF you uploaded.
- **Notes:**

## 4.10 `//` after a URL doesn't fire

- [PASS] Clear the composer. Type `https://example.com//` (URL ending with `//`).
- [PASS] No autocomplete menu should appear — the boundary check should reject this as a macro trigger (regression for the trigger-detection logic).
- **Notes:**

## 4.11 `//` mid-sentence after space DOES fire

- [PASS] Type `Some text //`. Menu should appear (whitespace before `//` is a valid trigger boundary).
- [PASS] Type `formatted` and Enter. Macro should insert at that position, `Some text` remains intact before it.
- **Notes:**

---

# Section 5: GitHub sync (5 min)

Tests both push (admin) and the simulation of "teammate pulls for the first time".

## 5.1 Push current state (after Section 3 edits)

- [PASS] In the macros editor, click **⬆ Push**.
- [PASS] Section 3 modified `qa-formatted` (test 3.1) so a one-file update is expected. Status should read `Pushed — 1 updated, 3 unchanged.` or similar — no SHA mismatch errors.
- [PASS] On GitHub, the latest commit should be `Update macro: qa-formatted`.
- [PASS] (Earlier this test was written assuming Section 3 left state untouched — that was a mistake. Test 3.1 always edits qa-formatted, so a one-file update is the expected post-Section-3 state.)
- **Notes:**

## 5.2 Edit + push

- [PASS] Open `qa-greeting`. Append the word `(edited)` to the body. Click **Save**.
- [PASS] Click **⬆ Push**. Status: `Pushed — 1 updated.`
- [PASS] On GitHub, the latest commit should be "Update macro: qa-greeting".
- [PASS] **Retest after v2.0.7:** the SHA mismatch was caused by Chrome serving a cached GitHub Contents API list response between the listing and the PUT. Fix: `cache: 'no-store'` + `Cache-Control: no-cache` headers on all sync reads.
- **Notes:**

## 5.3 Simulate teammate pull (the important one)

- [PASS] In the macros editor, **delete all four `qa-*` macros** (click each, click Delete, confirm). Sidebar should now be empty (or have only macros you created outside this checklist).
- [PASS] Click **⬇ Pull**.
- [PASS] Status should report `Pulled 4 macros — 4 added, 1 attachment.` (or similar — the actual numbers depend on whether you have other macros in the repo).
- [PASS] All four `qa-*` macros should reappear in the sidebar.
- [PASS] Open `qa-greeting` — the `(edited)` text from 5.2 should be there. (Cascade: this only worked after 5.2 was fixed in v2.0.7.)
- [PASS] Open `qa-with-pdf` — the PDF should be in the attachment list.
- **Notes:**

## 5.4 Pull without internet (graceful failure)

- [PASS] In Chrome DevTools, set Network → **Offline** for the macros editor tab.
- [PASS] Click **⬇ Pull**.
- [PASS] Status should show a clear error like `Pull failed: NetworkError` or similar — NOT a hang or empty state.
- [PASS] Set Network back to **No throttling** for the rest of the tests.
- **Notes:**

## 5.5 Push with bad token (graceful failure)

- [PASS] Click **Settings ▾** in the sync bar. Click **Forget token**.
- [PASS] Click **Save token** with a deliberately invalid token, e.g. `ghp_invalidtoken12345`.
- [PASS] Click **⬆ Push**.
- [PASS] Status should show: `Push failed: Token rejected (401). Generate a new one and try again.` (or equivalent).
- [PASS] Click **Forget token**. Re-enter your real token. Verify a successful Push works again.
- **Notes:**

---

# Section 6: PDF viewer & misc (5 min)

## 6.1 PDF in customer message opens in modal

- [PASS] Find any customer or agent message in any ticket that has a PDF attachment link. (If you don't have one, skip and tell me.)
- [PASS] Click the PDF link. A fullscreen modal should open with the PDF rendered (Mozilla PDF.js viewer with toolbar at the top).
- [PASS] Press **Escape**. Modal closes.
- [PASS] Click the PDF link again. Click outside the modal (on the dimmed backdrop). Modal closes.
- **Notes:**

## 6.2 Cmd+click bypasses the modal

- [PASS] Cmd+click (Ctrl+click on Windows/Linux) the same PDF link.
- [PASS] The PDF should open in a new browser tab using Chrome's native PDF viewer — NO modal in the Zendesk tab.
- **Notes:**

## 6.3 Right-click context menu unaffected

- [PASS] Right-click the PDF link. Chrome's native context menu should appear with options like "Open link in new tab".
- [PASS] Press Escape to dismiss.
- **Notes:**

## 6.4 Language override dropdown (optional, you said you don't use this)

- [PASS] Click the small `▼` next to the reply translate flag. A dropdown of all 24 supported languages should appear.
- [PASS] Pick a language different from the customer's. The flag emoji updates. If there's English text in the composer, it auto-retranslates to the new target.
- [PASS] Pick the original language back to restore.
- **Notes:**

## 6.5 LibreTranslate fallback triggers (advanced — optional)

This one's harder to test reliably because it requires Google to fail. Use Chrome DevTools' request blocking:

- [PASS] Open DevTools → Network tab → Filter for `googleapis`.
- [PASS] Right-click any request to `translate.googleapis.com` → "Block request URL".
- [PASS] In the internal note, type a fresh English sentence and click the translate flag.
- [ ] Translation should still complete, using LibreTranslate. Console should log something like a successful response from your LibreTranslate server.
- [ ] In Network tab, "Unblock" the URL when done.
- [ ] If you can't / won't do this test, write SKIP.
- [ ] **Retest after v2.0.7:** the toast now combines BOTH provider errors so we can see what LibreTranslate actually said. If this still fails, capture (a) the new toast text — it should now mention LibreTranslate's specific error, (b) the Network tab's failed LibreTranslate request: status code, response body, response headers, (c) whether the request appears at all in the Network tab. The most likely cause is CORS — the LibreTranslate server needs to allow `chrome-extension://*` or your specific extension origin in its CORS config.
- **Notes:**

---

# After the run

## Summary line

- [ ] Total tests run: **__** / **__**
- [ ] Passed: **__**
- [ ] Failed: **__**
- [ ] Skipped: **__**

## Top issues to investigate (write up to 3)

1. _(test number, one-line description)_
2. 
3. 

## Hand back to the engineer

Paste this entire file (with checkboxes ticked and notes filled) into the chat. I'll triage failures into a fix list and we'll work down it in priority order.
