# Roadmap

What exists, what does not, and what will not.

## Built and verified

- Multi-channel support (Stable / PTB / Canary) as separate origins
- Profile system with real Chromium session-partition isolation, plus
  ephemeral profiles
- Privacy policy engine with three presets and per-profile overrides
- Request classifier for telemetry, error reporting, trackers, browser
  services, Ghost Mode, activities and off-platform media
- Privacy Inspector with a live, in-memory ledger
- Permission gating with native prompts and default-deny
- Navigation containment and external-link handling
- User-agent and client-hint normalization, `Referer` minimization, `Sec-GPC`
- Per-profile proxy (SOCKS5/HTTP/PAC) with validation that fails safe
- Secure DNS (DNS-over-HTTPS) via the Chromium host resolver
- Portable data directory with read-only fallback
- Reliability watchdog: crash, hang, load failure, sleep/resume, network return
- Tray with per-profile unread counts
- Electron fuses, hardened macOS entitlements, atomic config writes
- Close-to-tray: closing hides the window so the connection and notifications
  survive, and quitting stays explicit
- Encrypted profile vault: AES-256-GCM under a scrypt-derived passphrase,
  sealed at quit and opened at launch, with a lock screen and idle auto-lock
- Settings panel with a grouped sidebar: Profiles, Privacy &amp; Security,
  Vault &amp; Lock, Network, Inspector, Appearance, About
- Unified/Classic layout setting with live in-panel previews, and a switcher
  strip pinned over the sidebar with a remembered side (see below for how far
  this goes)
- 101 unit tests over the pure policy, rule, network, appearance, stylesheet
  and vault modules
- 34 end-to-end tests that launch the real app, committed and wired into CI
- 2 smoke tests against a packaged, fully-fused build, which is the only place
  a whole class of fuse-dependent bug is visible

The end-to-end suite is the one that matters for regressions: it asserts the
panel opens on the requested pane, the preload bridge exists, profiles are
created and deleted through the real IPC path, a preset survives a DNS change,
`/api/v9/science` is refused with `ERR_BLOCKED_BY_CLIENT` and recorded in the
ledger, `session.resolveProxy` reports Chromium genuinely routing through a
SOCKS5 proxy while an invalid rule falls back to the system proxy and not to a
direct connection, clicking the switcher strip swaps the stylesheet Discord's
page is actually running, the gap that stylesheet reserves matches the strip's
real height, a weak passphrase is refused by the main process and not merely
styled red, the lock screen ends up above every other view and the settings
panel cannot be opened past it, closing hides the window instead of destroying
it, and all three of our pages load with no page errors or CSP violations.

The vault's own suite is separate and does the round trip for real: it seals a
profile tree, checks the plaintext is gone and that no recognizable bytes
survive in the ciphertext, opens it again and compares every file, flips a byte
to confirm a tampered vault is refused instead of half-extracted, and checks
that turning the vault off while the data is still sealed is refused, since
otherwise that button would quietly mean "delete my account".

## The unified layout

`unified` puts a two-way switcher along the top of the sidebar and one list
below it. DMs on one side, Servers on the other, one on screen at a time.

There is no folder model of our own. Discord already has server folders, with
drag and drop, stored on your account and synced to every device you use. A
second folder system beside it would be a hand-curated copy of something that
already works, so the Servers tab shows Discord's own list and its folders come
with it. Dragging a server into a folder is Discord's interaction, not ours; we
only have to avoid breaking it.

That also settles the question of where the list comes from. Discord renders it,
so nothing has to be enumerated, no API is called, and no script goes into the
page. The switcher is our own view, 240×40, pinned over space the stylesheet
reserves at the top of the sidebar. Which side of Discord's sidebar is visible
is decided by that stylesheet, injected from the main process, the same thing a
browser user stylesheet does.

The strip's page is transparent, so what shows between the pills is Discord's
own sidebar. That is not only cosmetic: it means the strip matches whatever
theme you are using without ever reading one.

The main process knows where you are from the URL alone. `/channels/@me/...`
is direct messages, `/channels/<id>/...` is a server and names which one, so
the strip follows navigation without reading anything out of the page. Opening
a DM from a notification moves it to the DMs side on its own.

**Shipped and verified:** the layout setting, the strip, the remembered side,
the URL-to-context reader, and the whole injection path. The stylesheet is
seeded into the data directory, injected on the profile view, swapped when the
side changes, removed under Classic, and reloaded when the file is saved. The
strip is attached under Unified and detached under Classic, and the gap it fills
is measured against its real height instead of written down twice. All of that
is checked against a running app.

**Not verified, and cannot be from a machine that cannot reach Discord:**
whether the selectors match. Discord's class names are hashes that change on
every deploy and differ per release channel, so the shipped rules are a
starting point, not an answer.

The stylesheet reports its own state to make that easy to tell apart. In
DevTools on the Discord view:

```js
getComputedStyle(document.documentElement).getPropertyValue("--nya-side")
```

`dms` or `servers` means the file is applied and the switcher is driving it, so
any remaining problem is in the selectors. Empty means nothing was injected,
which is a different bug.

When the selectors stop matching, both sides fall back to looking like ordinary
Discord. Degraded, never broken.

## Next

**Global push-to-talk.** The web app's push-to-talk only works while the window
is focused, which is a real gap versus the official desktop client.

An earlier draft of this roadmap said `globalShortcut` could fix it. That was
wrong, and the reason is worth recording so nobody spends a weekend on it:

1. `globalShortcut` delivers *keydown only*. Push-to-talk needs press **and**
   release, and Electron has no global keyup.
2. Even with both edges, muting the microphone is a page-level action. Chromium
   exposes no per-session microphone mute to the main process
   (`setAudioMuted` is output, not input), so acting on the key would mean
   reaching into Discord's page, the architecture this project rejects.

A correct implementation needs a native global key hook, which costs the
zero-runtime-dependency property. `webContents.sendInputEvent` can forward
synthetic key events to an unfocused window without injecting any script, so
the *delivery* half is solvable; the *detection* half is not, without a native
module. Worth doing behind an optional native addon, not worth faking.

**Notification control.** Currently limited to permission gating. Rewriting
notification bodies, to keep message previews off a lock screen, is not
reachable from the main process: renderer-created `Notification`s have no
main-process interception hook, so content control would again require page
injection. Per-profile enable/disable and quiet hours are achievable and are
what this item should mean.

**Screen share with audio on Linux.** The hard one. Vesktop solved it with a
native PipeWire helper; doing it here means either a native module (which costs
the zero-dependency property) or a PipeWire path through
`setDisplayMediaRequestHandler`. Worth investigating, not worth rushing.

**Re-sealing on lock, not only on quit.** Today *lock now* drops the key and
covers the screen; the files stay readable until you quit. Sealing a running app
means releasing Chromium's handles on the partition, and Electron has no way to
destroy a session, so this needs either a teardown path or a RAM-backed working
directory. `docs/SECURITY.md` says plainly which one is shipping.

**Vault coverage for `config.json`.** Settings, profile names and proxy rules
sit outside the vault because the policy has to be read before Chromium starts,
which is before a passphrase can be asked for. Splitting a small boot config out
from the rest would close it.

**Policy import/export.** A reviewable, shareable policy file so a community can
maintain rule sets the way blocklists are maintained.

**Rule set updates.** Tracker host lists go stale. Any update mechanism must be
manual or explicitly opt-in. An auto-updating client that phones home for rules
would contradict the whole exercise.

**Window state per profile.** Zoom level and scroll position currently follow
the window, not the profile.

**Accessibility pass.** Both tab lists carry `role="tablist"` and
`aria-selected`, and the switcher strip takes arrow keys with a single tab stop.
Still missing: the same arrow-key handling on the settings sidebar, focus
trapping while the panel is open, and a keyboard-navigable ledger.

## Out of scope, permanently

**Plugin and theme JavaScript injection.** This is the line that defines the
project. Running third-party script inside the origin that holds your session
token destroys every security property in `docs/SECURITY.md` and is exactly
what Discord's terms describe. User CSS via `insertCSS` is supported: styles,
never script, and that is where it stops.

**API reimplementation and self-bot features.** Auto-reply, mass actions,
scraping, anything that makes your token behave like automation. The risk lands
on the user's account.

**Message logging and anti-delete.** Storing other people's deleted messages is
a privacy violation dressed up as a privacy feature. Nyacord is a client that
avoids collecting data about you; it will not start collecting data about the
people you talk to.

**Spoofing the operating system.** Explained in `docs/PRIVACY.md`: it makes you
more identifiable, not less.

**Rewriting `X-Super-Properties`.** Explained in `docs/RESEARCH.md`: it trades a
small metadata win for an anti-abuse signal, and the cost lands on the user.

**Telemetry of our own.** Including "anonymous" usage statistics and crash
reporting. There is no acceptable amount.
