# Architecture

## The one-sentence version

Nyacord is a purpose-built browser that loads Discord's web application and
enforces privacy and security policy from outside the page, where the page
cannot see or subvert it.

## Process and view layout

```
main process  ── privileged. Owns config, policy, sessions, filtering.
   │
   └── BaseWindow
        ├── WebContentsView  (profile "work"   → persist:nya-a1b2)  ← Discord, NO preload
        ├── WebContentsView  (profile "canary" → persist:nya-c3d4)  ← Discord, NO preload
        ├── WebContentsView  (switcher strip, file://, partition "nya-shell") ← 240×40, top-left
        └── WebContentsView  (shell UI,       file://, partition "nya-shell") ← settings panel
```

Only one profile view is attached to the window at a time; switching profiles
swaps which child view is mounted instead of reloading anything, so background
profiles keep their gateway connection and unread state.

The shell view is added on top when the panel opens and removed when it closes.
It is transparent, so Discord stays visible behind it.

The switcher strip is the unified layout's only UI. It is a real view pinned to
the top-left corner, over space the layout stylesheet reserves at the top of
Discord's sidebar, and it is attached only while that layout is selected. It is
transparent too, which is what lets it inherit Discord's theme: what shows
between the pills is Discord's own sidebar, so the strip never has to learn
which theme is in use. Both overlays are re-raised after any view is mounted
underneath them, because `addChildView` moves an existing child to the front.

### Why the Discord view has no preload

Nothing of ours runs inside Discord's page. There is no `contextBridge`, no
injected script, no IPC channel reachable from that renderer.

This is the decision the rest of the design hangs off. It buys three things:

1. **Security.** A renderer compromise, say a malicious embed or a Chromium
   0-day, finds no bridge to the main process, because there is not one.
2. **Honesty.** "We do not modify Discord" is verifiable by reading
   `src/main/window.ts` and observing the absence of a `preload` key, rather
   than by trusting a claim about what the injected code does.
3. **Policy integrity.** Every rule is enforced in the main process. A page
   that wanted to disable Ghost Mode has nothing to call.

The cost is that anything needing page context is out of scope by
construction: themes that read the DOM, plugins, patched components. That is a
trade, not an oversight. User CSS is supported via
`webContents.insertCSS`, which injects styles and never script.

### Why profiles are sessions, not tabs

A profile owns a Chromium session partition: its own cookies, localStorage,
IndexedDB, cache and service workers. Two profiles are two identities that
cannot observe each other, which is what makes "work account on Stable,
personal on Canary" meaningful instead of cosmetic.

Ephemeral profiles use an in-memory partition, so everything goes on close.

Partition names are *derived* from the profile id (`src/common/profile.ts`),
never stored, and the id is stripped to `[A-Za-z0-9_-]`. A hand-edited config
cannot point a profile at an attacker-chosen partition.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/common/` | Pure logic, no Electron import. Directly unit-testable. |
| `src/common/policy.ts` | The policy type, the three presets, and `normalizePolicy` |
| `src/common/rules.ts` | The request classifier: the whole blocking behaviour |
| `src/common/ua.ts` | User-agent and client-hint normalization |
| `src/common/network.ts` | Proxy and secure-DNS configuration and validation |
| `src/common/appearance.ts` | Layout mode, switcher state, and URL-to-context reading |
| `src/common/stylesheet.ts` | Splits the layout stylesheet into its per-side sections |
| `src/main/layout.ts` | Seeds, reads and watches the editable layout stylesheet |
| `src/common/portable.ts` | Where state should live |
| `src/common/ipc.ts` | The complete IPC surface, in one file |
| `src/main/config.ts` | On-disk shape, re-validated on load. Holds the global DNS setting, which is not part of `policy` because the host resolver is process-wide and can never be per-profile |
| `src/main/security/` | Session hardening, permissions, navigation containment |
| `src/main/privacy/ledger.ts` | The Privacy Inspector's in-memory record |
| `src/main/reliability/` | Crash, hang and network recovery |
| `src/preload/shell.ts` | The settings panel's bridge. Attached only to our own UI |
| `src/preload/switcher.ts` | The strip's bridge: two methods, the smallest surface in the app |
| `src/renderer/shell.*` | The settings panel. No `innerHTML` anywhere. |
| `src/renderer/switcher.*` | The switcher strip |

The `common` / `main` split is load-bearing. Everything deciding *what the
client does* lives in `common` and is tested without launching Electron.

## Startup order

Order is not arbitrary and getting it wrong is the classic way an app claims to
be portable while writing to `~/.config`:

1. `initializePaths()`: resolve the data directory. Chromium captures its
   paths during startup, so this has to come first.
2. `openConfig()`: read and re-validate config from disk.
3. `applyChromiumSwitches(policy)`: command-line switches must be set before
   `app.whenReady()`.
4. Single-instance lock, then windows.

Because switches are process-wide and set before a profile is chosen, they are
driven by the **global** policy only. Per-profile overrides govern request
filtering, permissions and headers, but not WebRTC policy. This asymmetry is
real and is written down in `docs/PRIVACY.md`.

## Request pipeline

Every request in a profile session passes through:

```
onBeforeRequest  → classify(facts, policy) → block + record in ledger, or continue
onBeforeSendHeaders → normalize client hints, minimize Referer, add Sec-GPC
```

`classify` is pure and lives in `common/rules.ts`. The Electron layer does
nothing but supply facts and act on the verdict, which means the entire
blocking policy is covered by `test/rules.test.ts` without a browser.

## Reliability

Four failure modes, one behaviour: back off, then reload.

- `render-process-gone`: the renderer crashed
- `unresponsive` / `responsive`: the page is hung
- `did-fail-load` on the main frame: a load failed
- `powerMonitor` resume and a network-online poll: the socket died while away

Backoff doubles to a 60 s cap and resets on a successful load. `ERR_ABORTED`
and `ERR_BLOCKED_BY_CLIENT` are explicitly *not* failures: the first is every
SPA route change, and the second is our own filter working. Retrying either
would spin forever and inflate the Inspector's counts.

## Testing

Two suites, split by what they can actually catch.

**`test/*.test.ts`, unit.** Pure modules only: the policy, the request
classifier, proxy and DNS validation, user-agent handling, portability. No
Electron, so they run anywhere in under a second.

**`test/e2e/*.e2e.ts`, end-to-end.** Launches the real packaged-layout app via
`playwright-core` and drives it through the actual IPC path.

The split exists because of where the bugs actually were. Every defect found in
this project so far was invisible to a pure function and only showed up when
the app ran: a sandboxed preload that could not resolve its imports, a panel
opening on the wrong pane, a "delete" that deleted half of what it promised, a
window that could not be re-shown, a CSP the panel itself violated. Each has a
test named after it now.

`playwright-core` is used instead of `playwright` because it
never downloads browsers: the target is Electron, and a browser download would
be pure cost.

## Build

- TypeScript compiles `src` and `test` to `dist/`.
- The preload and the renderer are then **bundled** by esbuild.

  For the preload this is a correctness requirement, not an optimization: a
  sandboxed preload's `require` can only resolve `electron` and a few node
  builtins, so a relative import of the shared IPC contract throws at load time
  and the bridge silently never appears.

  For the renderer it is what removes duplication. Without a bundler the panel
  has to be a plain global script, which means re-declaring every shared type
  and re-typing every constant that already exists in `src/common`.

  The two use different output formats, and the difference matters: the preload
  is CommonJS, the renderer is an **IIFE**. A CommonJS bundle loaded as a
  classic `<script>` puts its top-level `var` declarations on `window`, which
  collides with the read-only `window.nyacord` that `contextBridge` installs and
  throws before any UI renders.
- Renderer HTML and CSS are copied.
- `electron-builder` packages, and `build/afterPack.cjs` flips Electron fuses.

There are **zero runtime dependencies**. Everything in `node_modules` is a
build-time tool. The supply chain that reaches a user's machine is Electron
and our own code.
