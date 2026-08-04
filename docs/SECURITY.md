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
| Someone who takes the machine while it is off | The disk, a clone of it, or a backup | **The vault**: profile data is AES-256-GCM under a passphrase you hold |
| Someone at your unlocked machine, briefly | Whatever is on screen | **The lock screen**: manual or on idle |
| Someone at your unlocked machine, with time | Everything, including memory | Out of scope. Nothing a user-space app does survives this. |
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

`backgroundThrottling` is **false** on purpose. It is the one setting here
chosen for behaviour, not security: throttling the renderer breaks
notification delivery and voice keepalives when the window is not focused, and
a chat client that silently stops delivering messages when minimized is not a
chat client.

## The vault

Turning the vault on sets a passphrase. From then on, quitting seals
`session/Partitions` into a single encrypted file, and starting up asks for the
passphrase to open it again. That tree holds every profile's cookies,
localStorage (where Discord keeps your token), IndexedDB, cache and service
workers.

| | |
| --- | --- |
| Cipher | AES-256-GCM, one key over the whole archive |
| Key derivation | scrypt, N=2¹⁷ (128 MiB), r=8, p=1, per-vault salt |
| Integrity | The GCM tag. A tampered vault is refused, not partly extracted. |
| Where the key lives | Main-process memory, from unlock until seal or lock |
| Recovery | None. No escrow, no hint, no reset. |

Two details worth stating:

**Unsealing stages first.** Decrypting straight into the profile directory
would write plaintext that had not been authenticated yet, so a truncated or
tampered file would leave a half-extracted profile behind before the tag check
failed. It extracts to `Partitions.opening`, verifies, then renames into place.

**Entry paths out of a vault are untrusted.** The file may not have been
written by us. Anything that could escape the extraction root is refused, not
sanitized: absolute paths, `..`, drive letters, backslashes.

### What the vault does not do

**It is not encryption while the app is running.** Chromium reads and writes
those files, so between unlock and quit they are plaintext on disk. No wrapper
can change that: Chromium exposes no hook to encrypt its own storage writes,
and a client that could not hand it real files could not run. Every "encrypted
profile" browser has this limit, whether or not it says so.

What the vault buys is the powered-off case: the stolen laptop, the cloned
drive, the backup that outlives the machine.

**Locking is not sealing.** *Lock now* and auto-lock drop the key and put an
opaque screen over everything, so nothing is readable to someone at the
keyboard. They do not re-encrypt the files: Electron cannot destroy a session,
and Chromium keeps its handles until the process ends. Sealing happens at
quit.

**It does not protect against someone who is already running code as you.**
Malware in your user account can read the plaintext while the app is open, or
read the key out of process memory. Node cannot pin a buffer out of swap
without a native module, so the key may reach the page file.

**It does not cover `config.json`**, which holds settings, profile names and
proxy configuration. No Discord data is in there, but the file does reveal that
you use the app and what you called your profiles.

**Use full-disk encryption as well.** FileVault, BitLocker or LUKS covers the
running window, the swap file, and everything the vault leaves outside itself.
The vault is still worth having on top, since it survives a machine left logged
in, but it is not a replacement.

## Is Chromium itself hardened?

Mostly yes, by inheritance, with two gaps.

**What comes for free.** The renderer sandbox (seccomp-bpf on Linux, App
Container on Windows, Seatbelt on macOS), site isolation, the V8 sandbox,
partitioned network state, ASLR, CFI and stack protection. This is the most
attacked codebase on the planet and it shows; it is the main reason this
project is a shell around Chromium and not a reimplementation of anything.

**What we add.** `app.enableSandbox()` before ready, `site-per-process` stated
explicitly so a default flip cannot cost it silently, `HARDENED_PREFS` on every
view, no preload on Discord's, and the fuses in `build/afterPack.cjs`. Those
last ones matter more than they sound: `ELECTRON_RUN_AS_NODE` turns any stock
Electron binary into a general-purpose Node interpreter, and `NODE_OPTIONS`
injects a module into the process from the environment. Both are off, along
with `--inspect`, plus ASAR integrity validation and `OnlyLoadAppFromAsar`.

`GrantFileProtocolExtraPrivileges` is off too, which costs more than it sounds:
asar path resolution is one of the privileges it removes, so a packaged build
could not load its own UI from `file://` at all. Rather than turn it back on,
the UI moved to a private `nya://ui` scheme served from the main process, with
an allowlist of nine filenames. `file:` stays de-privileged and our pages gain
a real origin.

**Gap one: patch lag.** Electron ships a Chromium branch and picks up security
fixes when Electron cuts a release. Chrome updates faster. There is no way for
a downstream project to close this. The mitigation is to track Electron
releases and rebuild, which is a maintenance commitment, not a feature.

**Gap two: Safe Browsing is off,** because it is a background service that
reports to Google, and blocking it is squarely what this project is for. The
practical cost is smaller than it looks: navigation containment keeps the
Discord view on Discord's host, and every external link opens in your real
browser, which has its own Safe Browsing. But a malicious link gets classified
by your browser, not by us.

Component updates are off for the same reason, which also means CRLSet
revocation data goes stale. TLS still verifies against the OS trust store;
revocation checking is the part that degrades.

## The IPC surface

The complete list of privileged operations is `src/common/ipc.ts`. The preloads
expose exactly those as named, fixed-arity functions. There is no generic
`invoke(channel, …)` escape hatch, so the privileged surface is reviewable as a
diff.

The three bridges are not the same size. The settings panel gets the full list.
The switcher strip, the one view of ours that sits over Discord's page all the
time, gets two methods: move to a named side, and be told which side is
showing. The lock screen gets two as well: attempt an unlock, and be told the
vault's public state. Neither can read the ledger or touch policy.

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
