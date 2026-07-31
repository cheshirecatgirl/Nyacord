# Research: the Discord client landscape

Notes taken before writing any code, and the conclusions drawn from them. This
is the "why Nyacord looks like this" document.

## The three families of Discord client

Every third-party Discord client falls into one of three architectural
families. The choice decides nearly everything downstream: risk profile,
maintenance burden, and which privacy claims are even possible.

### 1. API reimplementation

The client speaks Discord's REST and gateway protocols directly with a user
token. Examples include terminal clients and the various "self-bot" libraries.

- **Upside**: complete control, tiny resource footprint.
- **Downside**: this is what Discord's anti-abuse systems are actually built to
  detect. A user token driving non-official request patterns is the textbook
  self-bot signature, and it is a permanent treadmill, since undocumented
  endpoints change without notice.
- **Verdict for us**: rejected. The risk lands on the user's account, not on
  the developer, which makes it an unfair trade to ship by default.

### 2. Injection into the official client

The official Electron app is patched at runtime: `asar` replacement, a preload
shim, or a loader that pulls plugins into Discord's own renderer.
BetterDiscord, Vencord, Equicord and shelter all live here, as do the
distributions that bundle them (Vesktop, Legcord).

- **Upside**: enormous feature surface. Themes, plugins, patched React
  components, anything the page can reach.
- **Downside**: this is precisely what Discord's terms describe when they
  prohibit modifying the client. It also means arbitrary third-party JavaScript
  runs *inside the origin that holds your session token*. A malicious or
  compromised plugin has full account access, with no boundary left to enforce.
- **Verdict for us**: rejected as an architecture. A client whose headline
  claim is privacy and security cannot also be a general-purpose script
  injection host for the same origin that holds the token.

### 3. Hardened browser shell

The client is a purpose-built browser that loads Discord's own web app,
unmodified, and enforces policy from *outside* the page: at the network,
permission and navigation layers. WebCord is the reference
implementation of this idea.

- **Upside**: from Discord's perspective the traffic is a browser session,
  because it is one. Nothing is patched, no undocumented endpoint is called,
  and there is no injected script that could be compromised. Everything the
  client enforces is enforced where the page cannot see or subvert it.
- **Downside**: the feature ceiling is whatever the web app supports. No
  in-game overlay, no deep game detection, and push-to-talk is focus-bound
  unless the shell adds it natively.
- **Verdict for us**: adopted. See `docs/ARCHITECTURE.md`.

## What the reference implementations get right

**WebCord.** The shell model itself, the insight that user-agent sanitization
matters (an `Electron/x.y.z` token is a set of one), and treating
"stay inside the Terms of Service" as a design constraint from the start.

**Vesktop and Legcord.** That the desktop experience is the point. A tray, real
notifications, background operation, and Linux screenshare that actually works
are the difference between a wrapper and a client people use.

**Telegram Desktop and AyuGram.** Two things.

First, *portability done properly*: a data directory beside the executable, and
the machine is otherwise untouched. Most Electron apps treat portability as a
packaging format; Telegram treats it as a storage rule. Nyacord copies the rule,
not the packaging.

Second, *Ghost Mode*: the recognition that the most valuable privacy control in
a chat client is not encryption. It is not broadcasting your behaviour: typing
indicators, read receipts, online status. AyuGram implements this by
forking the client. We implement the network-observable parts of it by dropping
requests, which turns out to be enough for typing and read receipts and
explicitly not enough for presence (see `docs/PRIVACY.md`).

## What Discord actually sends

The surfaces worth knowing about, and how each is addressed:

| Surface | Mechanism | Can a shell block it? |
| --- | --- | --- |
| `POST /api/v*/science` | Batched analytics events | Yes: plain HTTP |
| Sentry ingest | Crash and error reports | Yes: plain HTTP |
| `POST /channels/{id}/typing` | Typing indicator | Yes: plain HTTP |
| Message acks | Read receipts | Yes: plain HTTP |
| Call quality reports | Post-call telemetry | Yes: plain HTTP |
| `X-Super-Properties` | Base64 client metadata: OS, locale, build number, release channel | Yes, but see below |
| `X-Fingerprint` | Opaque device fingerprint issued by Discord | Only by breaking the client |
| Presence / status | Gateway WebSocket frames | **No**: see below |
| Embedded activities | Third-party code on `*.discordsays.com` | Yes: block the host |
| WebRTC ICE candidates | Can reveal LAN addresses to peers | Yes: Chromium policy |

Two deliberate non-decisions:

**`X-Super-Properties` is left alone.** It is technically rewritable, and it is
tempting because it carries OS and locale. But it is also an anti-abuse input.
A session whose super-properties disagree with its TLS fingerprint, user agent
and behaviour is *more* anomalous than one that tells the truth, and the
downside of looking anomalous lands on the user's account. Sanitizing the
user agent removes a token no browser would ever send; rewriting
super-properties invents a browser that does not exist. Those are different
things and only the first is defensible.

**Gateway frames are not filtered.** Presence updates, typing receipt *reads*,
and most real-time state travel as frames inside a single WebSocket. Filtering
them requires either a man-in-the-middle on the connection or code inside the
page, which is the architecture rejected in family 2. So Ghost Mode covers what
HTTP can cover and Discord's own invisible status covers the rest. Claiming
otherwise would be theatre.

## Terms of Service

Discord's terms prohibit modifying the client and reverse-engineering it, and
Discord has publicly discouraged third-party clients. Enforcement in practice
has focused on automation and self-botting, not on people browsing
Discord in a browser.

Nyacord's position, stated plainly so users can make their own call:

- It loads Discord's own web application, unmodified, over HTTPS.
- It injects no JavaScript into that application.
- It reimplements no API and calls no undocumented endpoint.
- It blocks some of its *own* outbound requests, the same class of action as
  running an ad blocker or denying a permission prompt in Firefox.

That is a materially different posture from a patched client, and it is the
lowest-risk option that still delivers real privacy control. It is not a
guarantee, and nobody can honestly offer one. If your account matters to you,
that trade-off is yours to make, not ours to hide.

## Sources

- [SpacingBat3/WebCord](https://github.com/SpacingBat3/WebCord) and its
  [design docs](https://github.com/SpacingBat3/WebCord/blob/master/docs/Readme.md)
- [WebCord privacy notes](https://github.com/SpacingBat3/WebCord/blob/master/docs/Privacy.md)
- [AyuGram Ghost Mode documentation](https://docs.ayugram.one/shared/ghost/)
- [Discord tracking internals (unofficial)](https://luna.gitlab.io/discord-unofficial-docs/docs/science/)
- [Discord API reference (unofficial)](https://docs.discord.food/reference)
- [Electron security tutorial](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Discord Terms of Service](https://discord.com/terms)
- [Comparison of Discord clients](https://grokipedia.com/page/Comparison_of_Discord_clients)
