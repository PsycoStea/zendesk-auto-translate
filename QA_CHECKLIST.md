# QA Checklist

Run this end-to-end before tagging a new version. Keep it short — it's meant to be repeated often.

## Setup

- [PASS] `git pull` or reload the extension folder.
- [PASS] `chrome://extensions` → click reload (↻) on the extension card.
- [PASS] Hard-refresh the Zendesk tab (`Cmd+Shift+R`).
- [PASS] Open DevTools → Console on the Zendesk tab. Keep it open throughout.

## Customer-message translation

Run for **three** languages, at minimum German (`de`), French (`fr`), and Polish (`pl`):

- [PASS] Open a ticket with a non-English customer message.
- [FAIL] Colored language badge appears on the message, matches the actual language.
- [PASS] "📝 Translate to English" button appears beneath the message.
- [PASS] Clicking the button shows the blue translation box. Text is accurate (spot-check).
- [I have pasted the console output] No red errors in the console from our extension (ignore Zendesk's own `ERR_BLOCKED_BY_CLIENT` / `Hide Ticket Fields` noise).

## Reply translation

- [PASS] Write a short English reply.
- [FAIL] The reply toolbar shows a flag button matching the customer's detected language.
- [FAIL] Click the flag. Text is replaced with the translation.
- [FAIL] Wait 5+ seconds. The replacement persists (doesn't revert).
- [FAIL] Console shows `[zt] Reply replaced via strategy: ...`. Record which strategy won.

## Provider switching

- [PASS] In the popup, switch Provider → **LibreTranslate**, enter your URL and (optional) API key, click Save.
- [PASS] Chrome prompts for host permission. Accept.
- [SKIPPED, LibreTranslate not setup] Popup status row updates to "LibreTranslate".
- [FAIL] On Zendesk, click "Translate to English" on a new (uncached) message — translation comes back.
- [FAIL] Click the reply flag with an English reply — reply is replaced.
- [SKIPPED] Switch back to **Google Translate** in the popup. Google translations still work.
- [SKIPPED] Invalid LibreTranslate URL (e.g. a typoed host) produces an error toast on click, not a silent failure.

## Enable / disable

- [PASS - when I toggle the translator off, only then does the button to translate replies appear] Toggle **Enable Translator** off.
- [PASS] Language badges and buttons disappear from all customer messages.
- [FAIL] Reply flag button disappears.
- [PASS] Toggle back on.
- [PASS] Badges, buttons, and reply flag return on the existing (already-loaded) messages — not just on new ones.

## Error handling

- [ ] Block the translator host in DevTools Network tab (or turn off Wi-Fi briefly). Trigger a translation.
- [ ] An error toast appears in the bottom-right of the Zendesk page with a readable message.
- [ ] No unhandled promise rejections in the console.

## Popup

- [ ] Opens cleanly, no visible layout breakage.
- [ ] Version number matches the `manifest.json` version.
- [ ] Footer reads "Made for Mac Group Global".
- [ ] "How it works" section is not present.
- [ ] Detected language and cached translation count match what's on the ticket.

## If everything passes

- [ ] Bump version in `manifest.json` and the displayed version in `popup.html` if not already.
- [ ] Commit with a clear message.
- [ ] Tag the release (`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`).
- [ ] Tell the team to `git pull` and reload the extension.
