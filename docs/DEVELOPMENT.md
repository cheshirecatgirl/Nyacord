# Development

Setting up a machine to build, run and test Nyacord.

## What needs a real machine, and what does not

Most of this project is testable anywhere, including a headless cloud
container. Two things are not.

| | Runs headless | Needs a display | Needs Discord reachable |
| --- | :---: | :---: | :---: |
| `npm run typecheck` | ● | | |
| `npm test` (101 unit) | ● | | |
| `npm run test:e2e` (34) | ● via `xvfb` | ● | |
| `npm run test:packaged` (2) | ● via `xvfb` | ● | |
| Tuning the layout selectors | | ● | ● |
| Logging in, real-world use | | ● | ● |

The e2e and packaged suites only need *a* display, and `xvfb` is one, so a
container is fine for them.

The thing a container cannot do is reach `discord.com`. That matters for
exactly one job: the layout stylesheet targets Discord's class names, which are
content hashes that change on every deploy, so the shipped selectors are a
starting point and can only be confirmed against a real, logged-in Discord.
See [Tuning the selectors](#tuning-the-selectors).

## Prerequisites

- **Node 20 or newer** and npm. `node --version` to check.
- **git**.
- Roughly 1 GB of disk for `node_modules` plus the Electron binary, and another
  300 MB per packaged build under `release/`.

Nothing else. The project has zero runtime dependencies, and everything in
`node_modules` is a build tool.

### Linux

Electron needs a few system libraries that minimal images leave out:

```bash
sudo apt-get update
sudo apt-get install -y git xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libgbm1 libasound2 libxkbcommon0 libgtk-3-0
```

`xvfb` is only needed if the machine has no desktop session. On a normal Linux
desktop, skip it and run the test commands directly.

**Chromium's sandbox refuses to run as root**, so do not develop as root. If
you must, `--no-sandbox` would disable one of the properties this project
exists to keep, so use an ordinary user instead.

### macOS

Nothing to install beyond Node and git. `npm run dist` produces an unsigned
build; Gatekeeper will complain the first time, and right-click → Open is the
usual way past it. Signing needs an Apple Developer certificate and is out of
scope here.

### Windows

Nothing to install beyond Node and git. Use PowerShell or Windows Terminal.
`npm run dist` produces both a portable `.exe` and an NSIS installer.

## First run

```bash
git clone https://github.com/cheshirecatgirl/Nyacord.git
cd Nyacord
npm install
npm start
```

`npm start` builds and launches. First launch creates a default Stable profile
and shows Discord's login page.

## The commands

```bash
npm run typecheck      # tsc --noEmit, no build
npm run build          # clean, tsc, bundle preloads/renderers, copy assets
npm start              # build and run
npm run dev            # build and run with DevTools reachable
npm test               # 101 unit tests over the pure modules
npm run test:e2e       # 34 end-to-end tests against the real app
npm run test:packaged  # 2 smoke tests against a packaged, fused build
npm run dist:dir       # package, unpacked, into release/
npm run dist           # package installers for the current platform
```

On a headless Linux box, prefix the two display-dependent suites:

```bash
xvfb-run -a npm run test:e2e
xvfb-run -a npm run test:packaged
```

**Never run bare `tsc`.** It writes into the same `dist/` that esbuild bundles
into, and clobbers the preload bundles with unbundled CJS that a sandboxed
preload cannot load. The symptom is a settings panel that opens empty. Always
go through `npm run build`.

## Tuning the selectors

This is the job that needs your own machine, and it is the last unverified
piece of the unified layout.

1. `npm run dev`, and log in.
2. **View → Toggle DevTools (Discord view)**, or <kbd>Ctrl/Cmd</kbd>+
   <kbd>Shift</kbd>+<kbd>D</kbd>. This item only exists in dev mode; a normal
   build closes DevTools on sight, because "open the console and paste this" is
   how Discord accounts get stolen.
3. In the console, ask the stylesheet what it thinks:

   ```js
   getComputedStyle(document.documentElement).getPropertyValue("--nya-side")
   ```

   - `dms` or `servers` — the file is applied and the switcher is driving it,
     so anything still wrong is in the selectors.
   - empty — nothing was injected. A different bug; check **Settings →
     Appearance → Stylesheet** for the path and that the file is not empty.

4. Inspect the sidebar, find the real class names, and edit the file at the
   path shown in **Settings → Appearance → Stylesheet**. Save it; the running
   app reloads it within about a second. No rebuild, no restart.

The rules to get right first are in `[shared]`: until the padding rule matches,
the switcher strip sits on top of Discord's own server rail instead of in space
reserved for it.

`assets/layout/unified.css` in the repo is the seed copy. The file you edit
lives in your data directory; copy your working version back into the repo when
it is right.

## Running Claude Code against this repo

Claude Code can drive everything above, including the display-dependent
suites, given `xvfb` on Linux or a normal desktop session elsewhere. What it
cannot do from a cloud container is reach Discord, so selector work has to
happen where you are logged in.

A useful split: let it do the building, testing and packaging, and keep the
DevTools inspection for yourself, pasting the class names you find back to it.

## Data directories

Nyacord writes to the OS application-data location by default. Any of these
keeps everything next to the executable instead:

```bash
mkdir nyacord-data            # the directory alone is enough
./nyacord --portable
NYACORD_PORTABLE=1 ./nyacord
./nyacord --data-dir=/path/of/your/choosing
```

`--data-dir` is what the test suites use, so a run never touches your real
configuration. The single-instance lock is keyed on the data directory, so two
copies in two directories run side by side.

## Things that will trip you up

**The packaged build behaves differently from the development build.** Fuses
are only applied when packaging, and one of them (`GrantFileProtocolExtraPrivileges`)
once broke every UI page in packaged builds while development stayed green.
That is what `npm run test:packaged` exists for. Run it before releasing
anything.

**Playwright cannot drive a packaged build.** It needs `ELECTRON_RUN_AS_NODE`,
which the fuses disable. The packaged smoke test attaches over
`--remote-debugging-port` instead, which is a Chromium switch and unaffected.

**e2e failures on a fresh clone are usually the sandbox.** Running as root, or
with no display, both fail in ways whose error messages point elsewhere.
