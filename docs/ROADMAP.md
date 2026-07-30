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
- Portable data directory with read-only fallback
- Reliability watchdog: crash, hang, load failure, sleep/resume, network return
- Tray with per-profile unread counts
- Electron fuses, hardened macOS entitlements, atomic config writes
- 41 unit tests over the pure policy and rule modules

Verified end to end by launching the packaged app under a virtual display:
window and views come up, the panel opens, profiles are created through the
real IPC path, presets apply, and a request to `/api/v9/science` is refused
with `ERR_BLOCKED_BY_CLIENT` and recorded in the ledger.

## Next

**Global push-to-talk.** The web app's push-to-talk only works while the window
is focused — a genuine gap versus the official desktop client. A shell can fix
this properly with `globalShortcut`, but it needs care: a global key grab is a
privileged, user-visible thing and must be opt-in, clearly indicated, and
never registered by default.

**Notification control.** Native notifications with per-profile rules, and an
option to strip message content from the notification body so previews do not
land on a lock screen.

**Screen share with audio on Linux.** The hard one. Vesktop solved it with a
native PipeWire helper; doing it here means either a native module (which costs
the zero-dependency property) or a PipeWire path through
`setDisplayMediaRequestHandler`. Worth investigating, not worth rushing.

**Per-profile proxy.** A profile is already a session, and sessions can carry
their own proxy configuration. This is the natural place for it and would let
one identity route over Tor or a VPN while another does not.

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
