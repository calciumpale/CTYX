# Douyin consecutive message sync

## Observed failure

The device remained connected and successfully reported conversation reads. From
2026-11-07 19:31 UTC, reads consistently returned 11 usable messages with
`reliable: false`; there was no transport or account authentication error.

Read-only inspection of the existing Chrome conversation confirmed that the
newest consecutive incoming text has no repeated avatar. Its rendered structure
uses an empty direct child `div.messageMessageBoxstackLayoutHideAvatar` inside
`div.messageMessageBoxcontentBox.messageMessageBoxstackLayout`. The placeholder
has width and height 32px, `flex-shrink: 0`, and `display: block`.

The extractor only recognized actual visible avatars, so this normal grouped
message became unknown-author and prevented reliable ingestion of the snapshot.

## Change

Recognize that exact empty placeholder only for same-row geometry checks in the
confirmed stack layout. Continue to require a single slot, a single message
body, consistent flex direction, nonoverlapping boxes and matching side bounds.
The placeholder supplies no account identity. Do not infer authors from nearby
messages. Retain media, coverage, identity and send-state safety checks.

## Verification

- Full browser-enabled suite: 1085 passed, no failures or skips.
- Final transcript regression file after the containment guard: 14 passed.
- Focused transcript/bridge suites: 107 passed. Grouped inbound/outbound and
  outside-content-body regressions were observed failing before their fixes.
- Typecheck, token checks (72 files), diff checks and production build passed.
- Installed helper and source parser SHA-256 match. The app signature and bundled
  browser checks passed; the prior app remains as an installer backup.
- Site v54 deployed successfully, preserving custom audience and environment
  revision 3. Source commit `ebd2872dec5cca6ef62cca76116f63fb28651ddd`.
- Live reads at 19:51:14 and 19:51:47 UTC returned all 12 messages, reliable and
  successfully reported. The workbench visibly shows both latest customer texts
  as synced, with AI follow-up mode restored and no sync error.

No synthetic customer message was sent. Existing login state was restored after
the helper update; diagnosis did not refresh the Douyin page.
