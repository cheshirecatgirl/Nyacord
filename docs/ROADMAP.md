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
- Settings panel with a grouped sidebar: Profiles, Privacy &amp; Security,
  Network, Inspector, Appearance, About
- Unified/Classic layout setting with live in-panel previews, a folder switcher
  with a remembered active tab, plus chat folders
  (see below for exactly how far this goes)
- 82 unit tests over the pure policy, rule, network and appearance modules
- 20 end-to-end tests that launch the real app, committed and wired into CI

The end-to-end suite is the one that matters for regressions: it asserts the
panel opens on the requested pane, the preload bridge exists, profiles are
created and deleted through the real IPC path, a preset survives a DNS change,
`/api/v9/science` is refused with `ERR_BLOCKED_BY_CLIENT` and recorded in the
ledger, `session.resolveProxy` reports Chromium genuinely routing through a
SOCKS5 proxy while an invalid rule falls back to the system proxy and not to a
direct connection, closing hides the window instead of destroying it, and the
panel loads with no page errors or CSP violations.

## The unified layout: what is shipped and what is blocked

The `unified` layout is the merged, Telegram-style navigation: a small folder
switcher along the top of the chat column, and below it one list showing only
the active folder. DMs and Servers are the first two tabs, your own folders
follow, and a server row looks like a DM row (icon, title, one line) until you
open it.

The switcher is the design. Stacking Direct Messages and Servers on top of each
other in a single scroll would be two lists sharing a container: more scrolling,
and no clearer sense of where you are. One list at a time, with a one-click
switch and a remembered active tab, keeps the column short and the current
context obvious.

None of this touches Discord. It is a rearrangement of navigation inside our own
window, the same class of change as picking a different window layout. No
injected script, no patched client, no API call. Nothing here changes the Terms
position described in `docs/RESEARCH.md`.

**Shipped:** the setting itself (`unified` default, `classic` fallback), the
switcher with built-in DMs/Servers tabs plus user folders, a remembered active
tab that survives restarts, the folder model with tones and ordering, folder
entries validated to Discord channel paths, and navigation, so clicking an
entry moves the active profile to that chat. Entries store a *path*, not a URL, so one
folder works on Stable, PTB and Canary alike.

**Blocked:** automatically populating the list with *your* actual DMs and
servers. Rendering the merged column is easy; knowing what belongs in it is not.
There are only three ways to learn your guild and DM list, and each one costs
something this project has refused to spend:

1. **Ask the Discord API with your token.** That is the self-bot signature, and
   the risk lands on the user's account. Rejected in `docs/RESEARCH.md`.
2. **Read it out of Discord's page.** That means injecting JavaScript into the
   origin holding your session token. That is the architecture rejected in
   `docs/ARCHITECTURE.md`, and what makes "we do not modify Discord" checkable.
3. **Have the user curate it.** No enumeration, so no cost. This is what ships:
   you add the chats you care about and get a merged, folder-grouped column over
   them.

Option 3 is useful and limited: a curated launcher, not a mirror of your
account.

Deciding between "keep the guarantee" and "auto-populate the list" is a product
decision with a security consequence, so it is not one to make quietly. If the
injection path is ever taken it must be an explicit, off-by-default, clearly
labelled mode. Never the default, never silent.

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

**Policy import/export.** A reviewable, shareable policy file so a community can
maintain rule sets the way blocklists are maintained.

**Rule set updates.** Tracker host lists go stale. Any update mechanism must be
manual or explicitly opt-in. An auto-updating client that phones home for rules
would contradict the whole exercise.

**Window state per profile.** Zoom level and scroll position currently follow
the window, not the profile.

**Accessibility pass.** The tab list now carries `role="tablist"` and
`aria-selected`. Still missing: focus trapping while the panel is open, arrow-key
navigation between tabs, and a keyboard-navigable ledger.

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
