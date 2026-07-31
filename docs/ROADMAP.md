# Roadmap

Honest status. What exists, what does not, and what will never exist.

## Built and verified

- Multi-channel support (Stable / PTB / Canary) as separate origins
- Profile system with real Chromium session-partition isolation, plus
  ephemeral profiles
- Privacy policy engine with three presets and per-profile overrides
- Request classifier — telemetry, error reporting, trackers, browser services,
  Ghost Mode, activities, off-platform media
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
- 60 unit tests over the pure policy, rule and network modules

Verified end to end by launching the app under a virtual display: window and
views come up, the panel opens on the requested pane, profiles are created
through the real IPC path, presets apply, a request to `/api/v9/science` is
refused with `ERR_BLOCKED_BY_CLIENT` and recorded in the ledger, and
`session.resolveProxy` confirms Chromium genuinely routes through a configured
SOCKS5 proxy while an invalid rule falls back to the system proxy rather than
to a direct connection.

## Next

**Global push-to-talk.** The web app's push-to-talk only works while the window
is focused — a real gap versus the official desktop client.

An earlier draft of this roadmap said `globalShortcut` could fix it. That was
wrong, and the reason is worth recording so nobody spends a weekend on it:

1. `globalShortcut` delivers *keydown only*. Push-to-talk needs press **and**
   release, and Electron has no global keyup.
2. Even with both edges, muting the microphone is a page-level action. Chromium
   exposes no per-session microphone mute to the main process
   (`setAudioMuted` is output, not input), so acting on the key would mean
   reaching into Discord's page — the architecture this project rejects.

A correct implementation needs a native global key hook, which costs the
zero-runtime-dependency property. `webContents.sendInputEvent` can forward
synthetic key events to an unfocused window without injecting any script, so
the *delivery* half is solvable; the *detection* half is not, without a native
module. Worth doing behind an optional native addon, not worth faking.

**Notification control.** Currently limited to permission gating. Rewriting
notification bodies — to keep message previews off a lock screen — is not
reachable from the main process: renderer-created `Notification`s have no
main-process interception hook, so content control would again require page
injection. Per-profile enable/disable and quiet hours are achievable and are
what this item should mean.

**Screen share with audio on Linux.** The hard one. Vesktop solved it with a
native PipeWire helper; doing it here means either a native module (which costs
the zero-dependency property) or a PipeWire path through
`setDisplayMediaRequestHandler`. Worth investigating, not worth rushing.

**Policy import/export.** A reviewable, shareable policy file so a community can
maintain rule sets the way blocklists are maintained.

**Rule set updates.** Tracker host lists go stale. Any update mechanism must be
manual or explicitly opt-in — an auto-updating client that phones home for rules
would contradict the entire point.

**Window state per profile.** Zoom level and scroll position currently follow
the window, not the profile.

**Accessibility pass.** The panel needs proper focus trapping, `aria-selected`
on the tab list, and a keyboard-navigable ledger.

## Out of scope, permanently

**Plugin and theme JavaScript injection.** This is the line that defines the
project. Running third-party script inside the origin that holds your session
token destroys every security property in `docs/SECURITY.md` and is exactly
what Discord's terms describe. User CSS via `insertCSS` is supported — styles,
never script — and that is where it stops.

**API reimplementation and self-bot features.** Auto-reply, mass actions,
scraping, anything that makes your token behave like automation. The risk lands
on the user's account.

**Message logging and anti-delete.** Storing other people's deleted messages is
a privacy violation dressed up as a privacy feature. Sable is a client that
avoids collecting data about you; it will not start collecting data about the
people you talk to.

**Spoofing the operating system.** Explained in `docs/PRIVACY.md`: it makes you
more identifiable, not less.

**Rewriting `X-Super-Properties`.** Explained in `docs/RESEARCH.md`: it trades a
small metadata win for an anti-abuse signal, and the cost lands on the user.

**Telemetry of our own.** Including "anonymous" usage statistics and crash
reporting. There is no acceptable amount.
