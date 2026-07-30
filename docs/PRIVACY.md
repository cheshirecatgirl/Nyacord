# Privacy

What Sable does, what it cannot do, and how to check both yourself.

## What Sable itself collects

Nothing. There is no analytics, no crash reporting, no update ping, no
telemetry of any kind, and no network destination in the codebase other than
Discord's own channel hosts. The Privacy Inspector's records live in memory and
are never written to disk.

This is easy to verify and you should: `grep -r "https://" src/` returns
Discord hosts and documentation links, and `dependencies` in `package.json` is
empty.

## What Sable blocks

Every entry below is enforced in the main process, is covered by
`test/rules.test.ts`, and is visible live in the Privacy Inspector
(<kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>).

### Always on (all presets)

| Blocked | What it is |
| --- | --- |
| `POST /api/v*/science`, `/track`, `/metrics` | Discord's analytics event pipeline |
| Sentry ingest, `/error-reporting*` | Crash and error uploads |
| Known tracker hosts | Google Analytics, GTM, DoubleClick, Segment, Amplitude, and similar |
| Chromium background services | Component updates, Safe Browsing, dictionary downloads, optimization hints |
| Crash reporting | Breakpad and Crashpad are disabled at the Electron layer |
| Hyperlink auditing (`<a ping>`) | Off |
| Domain reliability reporting | Off — Chromium otherwise reports network errors to Google |

### Ghost Mode (on from `strict` upward)

| Suppressed | Effect |
| --- | --- |
| `POST /channels/{id}/typing` | Nobody sees "… is typing" from you |
| Message acks (four endpoint shapes) | The server is never told you read a message |
| Call quality reports | No post-call voice/video telemetry |

**Read the side effects before enabling ack suppression.** Not acknowledging
reads means Discord genuinely does not know you read anything: unread badges
persist, and your read position does not sync to your phone or to another
device. That is the mechanism working correctly, not a bug. Typing suppression
has no such cost — it is purely outbound.

### Exposure controls

| Setting | Default | Effect |
| --- | --- | --- |
| Block embedded activities | off / on from `strict` | `*.discordsays.com` mini-apps run third-party code |
| Block off-platform media | on at `paranoid` only | Link previews and embeds cannot load from non-Discord hosts, so they cannot log your IP. Some images will not render. |

### Fingerprinting

| Setting | Effect |
| --- | --- |
| Sanitize User-Agent | Strips the `Electron/…` and product tokens. An `Electron` token is a set of one. |
| Normalize client hints | Rewrites `Sec-CH-UA*` so hints agree with the sanitized UA |
| Minimize `Referer` | Origin only for same-site, nothing cross-site |
| Global Privacy Control | Sends `Sec-GPC: 1` |
| Spellchecker | **Off by default** — Chromium fetches dictionaries from Google on first use |

Sable does **not** lie about your operating system. Claiming to be Windows
while `navigator.platform`, font metrics and media capabilities all say Linux
makes you *more* identifiable, not less, and the mismatch is itself a
fingerprint. We remove the token no browser would ever send and stop there.

### WebRTC

| Policy | Behaviour |
| --- | --- |
| `default` | Chromium's default; may expose LAN candidates to peers |
| `public_interface_only` | **Default.** Only the default-route interface |
| `disable_non_proxied_udp` | `paranoid`. Most private, most likely to degrade voice |

mDNS candidate obfuscation is explicitly enabled rather than left to Chromium's
default, so a future upstream flip cannot silently change our posture.

### Permissions

Default-deny. Camera, microphone, screen share, notifications and opening
external applications prompt with a **native** dialog — a compromised renderer
cannot draw a fake one or click it for you. WebHID, WebSerial, WebUSB and
Bluetooth are refused outright at the device-handler level, not merely
unprompted. Only the channel's own origin may request anything; an iframe from
an embedded activity is refused silently.

## What Sable cannot do

Stated plainly, because a privacy tool that overstates its reach is worse than
one that does less.

**Presence and online status are not filterable.** They travel as frames inside
the gateway WebSocket, not as separate HTTP requests. Filtering them would
require either intercepting the socket or running code inside Discord's page —
and code inside the page is the architecture this project deliberately rejected
(see `docs/RESEARCH.md`). Use Discord's own invisible status; it is enforced
server-side and works.

**`X-Super-Properties` is left intact.** It carries your OS, locale and client
build number. It is also an anti-abuse input, and a session whose metadata
disagrees with everything else about it is more anomalous than one that does
not. The downside of looking anomalous lands on your account.

**`X-Fingerprint` cannot be removed.** Discord issues it and the client needs
it.

**Discord still sees your traffic.** Sable is a hardened browser, not a proxy.
Your IP address, the servers you are in, and everything you send are visible to
Discord exactly as they would be in Firefox. If your threat model includes
Discord itself, no client-side tool solves it — that is a question about
whether to use the service at all.

**Per-profile policy does not cover WebRTC.** Chromium command-line switches
are process-wide and must be set before any profile is chosen, so WebRTC
policy follows the *global* setting even when a profile overrides everything
else.

**Portability is not perfect.** Sable directs its own state — config, cookies,
cache, logs — to the portable directory. Chromium may still use the OS
temporary directory for scratch data during a session.

## Verifying any of this

1. Open the Privacy Inspector. Every blocked request is listed with its
   category, method and full URL, live.
2. Run `npm test`. The classifier is tested directly, including that ordinary
   API calls, message sending and the gateway are *not* blocked.
3. Read `src/common/rules.ts`. It is one file, it is pure, and it is the entire
   blocking policy.
