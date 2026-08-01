# Security

## Threat model

Who we are defending against, in rough order of likelihood.

| Adversary | Capability | Nyacord's answer |
| --- | --- | --- |
| A malicious link or embed | Runs script in Discord's origin | Sandboxed renderer, no preload, no bridge to reach |
| A hostile web page after navigation | Full page control | Navigation containment: the view cannot leave the channel host |
| A third-party embedded activity | Runs code in an iframe | Blocked from `strict` up; refused all permissions regardless |
| A renderer exploit chain | Arbitrary code in the renderer | Chromium sandbox + no Node in renderer + fuses |
| Local malware without root | Reads app data, drops files next to the binary | Cookie encryption, ASAR integrity, `OnlyLoadAppFromAsar` |
| Someone with your unlocked machine | Everything | Out of scope. Use disk encryption and ephemeral profiles. |
| Discord itself | Sees your traffic | Out of scope: see `docs/PRIVACY.md` |

## Renderer hardening

Applied to every `WebContentsView` (`HARDENED_PREFS` in `src/main/window.ts`):

```
sandbox: true                     nodeIntegration: false
contextIsolation: true            nodeIntegrationInWorker: false
webSecurity: true                 nodeIntegrationInSubFrames: false
allowRunningInsecureContent: false  webviewTag: false
experimentalFeatures: false       navigateOnDragDrop: false
```

`app.enableSandbox()` is called before ready, so the sandbox is the process-wide
default, not something each window has to remember.

`backgroundThrottling` is deliberately **false**. It is the one setting here
chosen for behaviour, not security: throttling the renderer breaks
notification delivery and voice keepalives when the window is not focused, and
a chat client that silently stops delivering messages when minimized is not a
chat client.

## The IPC surface

The complete list of privileged operations is `src/common/ipc.ts`. The preloads
expose exactly those as named, fixed-arity functions. There is deliberately no
generic `invoke(channel, …)` escape hatch, so the privileged surface is
reviewable as a diff.

There are two bridges, and they are not the same size. The settings panel gets
the full list. The switcher strip, which is the one view of ours that sits over
Discord's page all the time, gets two methods: move to a named side, and be told
which side is showing. It cannot read the ledger, touch policy, or change the
layout mode.

Every handler in `src/main/ipc.ts` treats its argument as hostile: channel ids
are checked against a known set, policies go through `normalizePolicy`, and
profile ids are looked up, not trusted. The shell renderer is ours and
is sandboxed, but "the privileged side validates" is the only assumption that
survives a renderer compromise.

Listeners receive only the payload. The `IpcRendererEvent` is withheld because
it carries `sender`, which would hand the renderer a route back into the main
process.

**The Discord view has no preload and therefore cannot reach any of this.**

## Navigation containment

There is no address bar in a desktop shell, which means a page that navigates
itself somewhere else is a page whose destination the user cannot see. So the
Discord view is allowed to be Discord and nothing else:

- `will-navigate` and `will-redirect` to any other host are cancelled and
  handed to the OS browser.
- `setWindowOpenHandler` denies every popup and opens it externally instead.
- `will-attach-webview` is prevented outright.
- External opens are scheme-checked: only `https:`, `http:` and `mailto:`.

Host matching is suffix-based on a dot boundary, so `evil-discord.com` does not
match `discord.com`. This is tested.

## Config as untrusted input

`config.json` may be hand-edited, half-written by an older build, or restored
from another machine. It is re-validated on load, not cast:

- Unknown keys are dropped; malformed values fall back instead of throwing.
- Profile ids must match `^[a-zA-Z0-9_-]{1,32}$`.
- Session partitions are *derived* from the id, never read from disk.
- A corrupted file is copied aside and startup continues with defaults. Losing
  a window position is acceptable; refusing to launch is not.

Writes are atomic (temp file plus rename) and the file is created `0600`.

## Electron fuses

Flipped on the packaged binary by `build/afterPack.cjs`:

| Fuse | Value | Why |
| --- | --- | --- |
| `RunAsNode` | off | Otherwise the shipped binary is a general-purpose Node interpreter |
| `EnableNodeOptionsEnvironmentVariable` | off | Otherwise `NODE_OPTIONS` injects a module into our process |
| `EnableNodeCliInspectArguments` | off | No `--inspect` attach |
| `EnableCookieEncryption` | on | Cookie store encrypted at rest via the OS keychain |
| `EnableEmbeddedAsarIntegrityValidation` | on | Refuse to run a tampered bundle |
| `OnlyLoadAppFromAsar` | on | Stops "drop a modified JS file next to the app" persistence |
| `GrantFileProtocolExtraPrivileges` | off | `file://` pages get nothing extra |

The first two matter most: without them, an attacker who can set an environment
variable does not need a bug in Nyacord at all.

## The settings panel

Loaded from `file://` with a strict meta CSP (`default-src 'none'`,
`script-src 'self'`, `connect-src 'none'`) in a dedicated partition with no
cookies. It cannot navigate anywhere.

The renderer builds all DOM with `createElement` and `textContent`. There is no
`innerHTML` in the codebase, which matters because the Privacy Inspector
displays URLs pulled off the network, which have to stay inert text.

There are also no inline styles and no `style` attributes: `style-src 'self'`
is enforced with no `'unsafe-inline'`, so all presentation lives in the
stylesheet, including the per-channel accent colours. The panel loads with no
CSP violations.

## macOS entitlements

`build/entitlements.mac.plist` requests the minimum: a JIT for V8, the two
capture devices the user grants per call, user-selected files, and network
client. Notably absent are `apple-events` and
`disable-library-validation`.

## Reporting a vulnerability

Open a private security advisory on the repository, not a public issue.
Include the version, platform, and the smallest reproduction you can manage.
