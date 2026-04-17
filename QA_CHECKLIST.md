# QA Checklist

Run this end-to-end before tagging a new version. Keep it short — it's meant to be repeated often.

## Setup

- [ ] `git pull` or reload the extension folder.
- [ ] `chrome://extensions` → click reload (↻) on the extension card.
- [ ] Hard-refresh the Zendesk tab (`Cmd+Shift+R`).
- [ ] Open DevTools → Console on the Zendesk tab. Keep it open throughout.

## Customer-message translation

Run for **three** languages, at minimum German (`de`), French (`fr`), and Polish (`pl`):

- [ ] Open a ticket with a non-English customer message.
- [ ] Colored language badge appears on the message, matches the actual language.
- [ ] "📝 Translate to English" button appears beneath the message.
- [ ] Clicking the button shows the blue translation box. Text is accurate (spot-check).
- [ ] No red errors in the console from our extension (ignore Zendesk's own `ERR_BLOCKED_BY_CLIENT` / `Hide Ticket Fields` noise).

## Reply translation

- [ ] Write a short English reply.
- [ ] The reply toolbar shows a flag button matching the customer's detected language.
- [ ] Click the flag. Text is replaced with the translation.
- [ ] Wait 5+ seconds. The replacement persists (doesn't revert).
- [ ] Console shows `[zt] Reply replaced via strategy: ...`. Record which strategy won.

## Provider switching

- [ ] In the popup, switch Provider → **LibreTranslate**, enter your URL and (optional) API key, click Save.
- [ ] Chrome prompts for host permission. Accept.
- [ ] Popup status row updates to "LibreTranslate".
- [ ] On Zendesk, click "Translate to English" on a new (uncached) message — translation comes back.
- [ ] Click the reply flag with an English reply — reply is replaced.
- [ ] Switch back to **Google Translate** in the popup. Google translations still work.
- [ ] Invalid LibreTranslate URL (e.g. a typoed host) produces an error toast on click, not a silent failure.

## Enable / disable

- [ ] Toggle **Enable Translator** off.
- [ ] Language badges and buttons disappear from all customer messages.
- [ ] Reply flag button disappears.
- [ ] Toggle back on.
- [ ] Badges, buttons, and reply flag return on the existing (already-loaded) messages — not just on new ones.

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
