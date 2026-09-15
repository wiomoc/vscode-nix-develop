# Changelog

## 0.6.3

- The window title now names the devShell when it is not `default`: `[devShell: ci]` rather
  than a bare `[devShell]`. `default` is left unnamed, since it is what a bare `nix develop`
  picks and spelling it out distinguishes nothing.
- Implemented by registering a second `ResourceLabelFormatter` bound to the window's exact
  authority. VS Code resolves competing formatters by preferring the longest matching
  authority pattern, so it outranks the `nix-develop+*` fallback.


## 0.6.2

- **Fixes devShell windows not surviving a VS Code restart.** 0.6.0 encoded the authority
  payload as base64url, having verified that VS Code passes an authority through verbatim.
  That check only covered `--remote` on the command line. A window *restored from persisted
  state* comes back lower-cased — a URI authority is case-insensitive by RFC 3986 — so the
  payload decoded to mojibake and the window could no longer reconnect.
  The payload is now lower-case base32, whose single-case alphabet round-trips through the
  fold unchanged. Verified by actually restarting the editor, not just by reopening it.


## Unreleased

- **`nixDevelop.remote.patchServerLd` (default `true`) turns the `node` patching off.**
  With it off neither the binary nor the environment is touched and no nixpkgs attribute is
  evaluated at all -- the only way this costs nothing on a cold store. For hosts that
  resolve `/lib64/ld-linux-*` themselves: `programs.nix-ld`, or simply not NixOS. Left on,
  the extension does the two `patchelf` calls itself, as the previous release did
  unconditionally -- never `bin/code-server`'s own `VSCODE_SERVER_CUSTOM_GLIBC_*` hooks, for
  the two reasons the entries below give.

- **Fixes the banner "You are connected to an OS version that is unsupported by Visual
  Studio Code" in every devShell window.** The server decides it is running on an
  unsupported OS if its glibc is older than 2.28 *or* if `VSCODE_SERVER_CUSTOM_GLIBC_LINKER`
  is set in its environment -- and setting that variable was how the extension asked
  `bin/code-server` to patch its own `node` for NixOS. Microsoft's flag means "this server
  was made to run on an old distro"; here it meant the opposite, since the glibc patched in
  comes from current nixpkgs.
  The two `patchelf` calls now happen in the extension, before anything runs the launcher,
  so the variables never reach the server. The patch is checked before it is applied
  (`--print-interpreter` / `--print-rpath`), so a warm resolve rewrites nothing.
- **Fixes patching a `node` that another devShell's server is already running.** Servers
  outlive the window that started them and every devShell on the same commit shares one
  distribution, so there is usually a `node` from that exact file running -- and Linux
  refuses to write to a running executable, so `patchelf` failed with `open: Text file
  busy`. The launcher ignored that and exec'd an unpatched `node` anyway, which only worked
  where `programs.nix-ld` happened to be enabled. Patching now goes through a copy that is
  renamed into place: running servers keep the inode they started on, and the next server
  gets the patched binary.

- **A devShell can declare the editor's settings, not just its extensions.** A
  `vscodeSettings` attribute on `mkShell` -- `builtins.toJSON { "nix.serverPath" =
  "${pkgs.nil}/bin/nil"; }`, or one `key=value` per line -- is applied to that devShell's
  window. This closes the obvious gap in per-devShell extensions: pinning `nix-ide` in the
  flake achieves nothing while the editor still points `nix.serverPath` at a binary from
  the host, and the store path of the package the shell already provides is exactly the
  value that setting wants.
  The values go into the server's *machine* settings
  (`<server-data-dir>/data/Machine/settings.json`), which is per devShell for the same
  reason the extensions directory is, and which sits between user and workspace settings --
  so the shell can point the editor at its toolchain without overriding what the repository
  committed, and without writing anything into the workspace. Only declared keys are
  managed: other keys in that file, including edits made from the settings UI, survive, and
  a key the flake stops declaring is removed on the next open. The file is rewritten only
  when the effective settings change, so comments in it survive too.
  `nixDevelop.remote.settings` is the per-checkout equivalent and wins where both name the
  same key; `nixDevelop.remote.settingsFromFlake: false` turns the flake side off.
  Reading the shell is shared with extension discovery, so it costs no extra evaluation.

- **Works on VSCodium, and on rebuilds generally.** The claim that VSCodium "has no
  compatible server" was simply wrong: VSCodium publishes a REH (remote extension host)
  build for every release. Four things assumed Microsoft -- the download URL, the launcher
  name `bin/code-server`, a hardcoded `--strip-components=1`, and the `~/.vscode-server`
  search path -- and none of them are guesses any more. They are read from the running
  editor's own `product.json` at `vscode.env.appRoot`, so no product is named anywhere in
  the code and Code - OSS, Insiders and other rebuilds come along for free.
  VSCodium declares `serverApplicationName: "codium-server"`, `.vscodium-server`,
  `.vscode-oss`, and a `serverDownloadUrlTemplate` pointing at its own GitHub release with
  the tag already resolved -- so it needs no configuration at all. Microsoft's desktop build
  declares no template (the URL lives in its CLI), so `update.code.visualstudio.com` remains
  the fallback. Reading `product.json` on the *client* side is what makes this correct: a
  devShell window's own extension host has an `appRoot` inside the server, which describes
  the server rather than the editor that has to match it.
  Archive layout is detected, not declared: Microsoft wraps its distribution in one
  `vscode-server-<platform>/` directory and VSCodium uses none, so the tarball is unpacked
  flat and the distribution found either at the top or in a single wrapper. Getting this
  wrong leaves a directory that looks extracted and contains nothing, so it is now a clear
  error instead.
- `nixDevelop.remote.serverDownloadUrl` now defaults to empty, meaning "detect it". Set it
  only to override. It gained `${quality}`, `${version}`, `${os}` and `${arch}` alongside
  the existing `${commit}` and `${platform}`, which keeps any existing override working.
- Extensions under VSCodium come from Open VSX, since that is the gallery its server is
  built with. Anything published only to the Microsoft Marketplace cannot be installed into
  a devShell window there -- a property of VSCodium, not something this extension can fix.

- **`nixDevelop.remote.patchServerForNixOS` is removed; the server's `node` is always
  patched against a nixpkgs glibc.** A machine using this extension has Nix, so the glibc
  and patchelf are cached builds after the first, and patching a `node` that would have
  started anyway changes nothing at runtime. The `auto` mode was paying for a `/etc/NIXOS`
  stat and a `node --version` spawn on every resolve to decide something a devShell user
  nearly always wants.
- **Two bugs in that patching, which `auto` had been hiding** by skipping it on any machine
  where node already ran. Both broke the server outright once it became unconditional, and
  both would have hit anyone who set `patchServerForNixOS: "always"`:
  - The linker was taken from `nixpkgs#glibc`, which resolves to glibc's **bin** output and
    has no `ld-linux-x86-64.so.2`. The launcher printed "Patching complete." and then died
    with `cannot execute: required file not found`. It now asks for `nixpkgs#glibc.out`.
  - `VSCODE_SERVER_CUSTOM_GLIBC_PATH` goes to `patchelf --set-rpath`, which *replaces*
    node's RPATH. Supplying only glibc dropped libstdc++, so a patched node failed with
    `libstdc++.so.6: cannot open shared object file`. The rpath now carries
    `nixpkgs#gcc-unwrapped.lib` as well.
  - `storePathOf` also no longer picks the last of several printed store paths; an
    installable that does not name exactly one output is an error rather than a guess.
- **`aarch64-linux` is supported.** The ELF interpreter is named per architecture, so the
  name is now derived from `process.arch` (`ld-linux-x86-64.so.2` / `ld-linux-aarch64.so.1`)
  instead of being fixed at the x86_64 one; both values are nixpkgs'
  `stdenv.cc.bintools.dynamicLinker` for the matching system, and `nixpkgs#glibc.out`
  already resolves per system. An architecture with no entry throws naming it, and the
  computed linker is checked for existence before use — `armv7l` has no entry because
  nixpkgs itself leaves its name as the glob `ld-linux*.so.3`.
- Still unsupported: macOS, where `nixpkgs#glibc` does not build at all.

- **Idle devShell servers now stop themselves, and hand back what they held.** A server
  outlives the window that started it so the next one attaches instantly, but nothing
  noticed when the *last* window went away: VS Code never asks a server to exit, and a
  devShell window cannot sensibly kill the server it is running on. So every devShell ever
  opened left a Node process and a pinned toolchain behind until `Stop devShell server` was
  run by hand. The server is now started with `--enable-remote-auto-shutdown`: five minutes
  after its last extension host disconnects it exits on its own, and an extension host that
  reconnects inside that window cancels it, so reloads, restarts and reopens still land on
  the running server. The same timer starts at boot, which also collects a server that is
  started and then fails to be connected to -- previously an orphan for the life of the
  machine.
- **A departed server releases its GC root itself.** Without this, a self-retiring server
  would leave its profile pinning a whole toolchain in the store forever -- trading a leaked
  process for a leaked closure. The catch is that a server retires in the background, with
  no extension running to notice. The shell the server runs under now does it: it supervises
  the server instead of `exec`ing into it, and an `EXIT` trap deletes the lock and unlinks
  the profile. Possible because nothing in the chain daemonizes -- `nix develop --command`
  execs, and `bin/code-server` runs `node` as a child and waits on it -- so the shell
  outlives the server by exactly one step. `TERM`/`HUP`/`INT` are trapped as well; an
  untrapped signal would kill the shell outright and the `EXIT` trap would never fire.
  The release is guarded by the connection token. The profile is shared by every server for
  a devShell, so a server exiting while its replacement is already starting would otherwise
  pull the new one's GC root out from under it; the successor has already overwritten the
  lock with its own token, so a token that no longer matches means there is nothing to
  release. Only the symlinks Nix writes (`devshell` and its `devshell-<n>-link` generations)
  are removed -- Nix's own indirect root under `/nix/var/nix/gcroots/auto` points *at* those
  and is not ours to delete; removing them is what leaves it dangling for `nix store gc`.
  `Stop devShell server` and `findRunning` do the same work from the extension side, the
  latter as the backstop for a wrapper that never got to run (a SIGKILL, an OOM kill, a
  reboot). All three are idempotent.

- Internal: `authority.ts` contained a literal NUL (the payload field separator) and a literal
  U+FFFD. Either one is enough for `file`, `grep` and `git grep` to treat the whole file as
  binary and skip it silently, so the file returned no matches for any search and a review
  concluded one of its exports was dead. Both are now escapes, compiling to the same strings.
  A test keeps either from coming back.
- **`nixDevelop.impure` never worked.** `--impure` was placed before the Nix subcommand, and
  Nix accepts it only after one, so every invocation died with `unrecognised flag '--impure'`
  the moment the setting was turned on. It now sits where Nix expects it. The bug was hidden
  because a second defect kept the setting from reaching the resolver at all.
- **The devShell a running server lives in is now a GC root.** The server was started by a
  `nix develop` with no `--profile`, so `nix store gc` was free to collect store paths a live
  server still depended on. A profile per devShell is now written under
  `<globalStorage>/remote/profiles/<key>/`, shared with the environment capture, which had
  been keeping a second root of its own under a different key.
- Internal: `nix develop` is assembled in exactly one place (`developCommand` in `nix.ts`)
  rather than being hand-rolled in the server manager. The profile is part of its type, so
  the GC root cannot be omitted again, and `impure`/`extraArgs` can no longer drift between
  callers -- they previously applied inconsistently.
- **The selected devShell is no longer written to workspace settings.** Picking a shell
  opened a window against it *and* wrote `nixDevelop.devShell` into `.vscode/settings.json`,
  which meant trying out a devShell silently edited a file the project commits. The window's
  authority already carries the devShell, so the write bought nothing.
- The picker's "None" entry is gone with the setting it used to clear; dismissing the picker
  does the same thing.
- **`nixDevelop.devShell` and `nixDevelop.autoActivate` are removed.** Once the extension
  stopped writing the selection, `devShell` was a second, weaker answer to a question the
  window's authority already answers: a local window with the setting set was "a devShell is
  selected but you are not in it", a state whose only action was to offer to reopen. Deleting
  it leaves one representation of the choice instead of two that could disagree.
  `autoActivate` went with it -- with nothing to build on window open, it gated only the
  status bar and the picker offer, and `promptWhenUnset` already silences the latter.
  What this changes for a user:
  - Nothing is lost from the reopen flow: a devShell window still reconnects to its own shell
    on restart, since that lives in the authority.
  - A project that wants to state which shell it means says so in `.envrc` (`use flake .#ci`),
    which the picker now marks and offers first. That replaces the old mismatch warning, which
    compared two declarations and can no longer fire -- there is only one left.
  - `Reopen in devShell` always asks which shell rather than silently using the setting.
  - `Stop devShell server` asks which devShell when run from a local window; inside a devShell
    window it still targets that window's own server.
  - The "relaunch with --enable-proposed-api" warning now appears when you actually open a
    devShell window, instead of on any window with a `flake.nix` and the setting set.
- Internal: a test now checks that `package.json` and `readConfig` declare the same settings
  with the same defaults, in both directions. Nothing related the two before, which is how a
  setting could be contributed and never read, or half-removed.


## 0.6.1

- `ensureServer` now also reuses a server the VS Code CLI already downloaded
  (`<cli data>/servers/<quality>-<commit>/server`, as used by `code tunnel`), on top of the
  Remote-SSH location it already checked. Matching on the commit suffix avoids guessing the
  quality prefix and skips the `-web` builds, which serve a browser UI rather than a remote
  window. A miss just falls through to the download.
- The desktop application cannot be reused as a server: it ships `out/main.js` and an
  Electron binary, with no `out/server-main.js`, no `vs/server`, and no plain `node`. That
  is a different build, which is why `code serve-web` and `code tunnel` download one too.


## 0.6.0

- **The remote authority now describes its own target.** `nix-develop+<base64url payload>`
  encodes the folder, devShell and flake directory, replacing an opaque digest plus a JSON
  side table in global storage. The registry file, its cross-window synchronisation and the
  "unknown authority" failure mode are all gone, and an entry in "recently opened" keeps
  working across a cleared global storage or a different profile.
- Verified against a live resolver before relying on it: VS Code preserves authority case
  byte-for-byte (URI syntax would permit case-folding, which would destroy base64), and a
  126-character authority round-trips intact.
- Per-authority storage (server data, extension directory, lock file) is keyed by a
  16-character hash of the authority rather than the authority itself, which would otherwise
  grow with the folder path and could exceed the 255-byte limit on a path component.
- Authorities minted by an earlier version do not decode; the resolver now says so and asks
  for a fresh reopen instead of reporting an unknown id.


## 0.5.0

Two features removed, leaving one way to do things.

- **The shared extension directory is gone.** Every devShell now has its own, keyed by
  folder + devShell. A devShell's extension set is therefore exactly what it declares,
  pruning is unconditionally safe, and `nixDevelop.remote.isolateExtensions` no longer
  exists. Use **Install Local Extensions...** to seed a new devShell.
- **The `env` mode is gone.** A selected devShell is used by opening a window whose server
  runs inside `nix develop` -- there is no longer a second path that copies environment
  variables into the current window. That path could never reach extensions already
  activated, so it behaved subtly differently from the real thing; `direnv` is the better
  tool for putting a devShell into a plain shell.

Removed with them: `nixDevelop.mode`, `nixDevelop.applyToExtensionHost`,
`nixDevelop.respectDirenv`, `nixDevelop.ignoredVariables`, `nixDevelop.pathLikeVariables`,
and the **Reload environment** and **Deactivate** commands. Without the `resolvers`
proposed API there is now no fallback, so the extension says so on activation instead of
failing at reopen.

direnv handling shrinks to what still matters: the terminal is no longer contended, so only
a devShell *mismatch* between `.envrc` and the workspace is reported.


## 0.4.1

- **Switching devShells no longer breaks a running extension host.** Nix-supplied extension
  links were pruned to match the devShell being started, but the extension directory is
  shared by default -- so starting one devShell unlinked another's extensions while its
  server had them activated, leaving it holding an extension it could no longer load.
  Pruning now happens only for an isolated directory, which belongs to a single devShell;
  a shared directory is only added to. A version bump still retargets the link in both
  modes, so an extension is never left without files.
- Switching devShells inside a devShell window now stops the server it leaves behind,
  rather than leaking one per switch with the old extension set still loaded.

## 0.4.0

- **Nix-supplied VS Code extensions.** A devShell can now put extension *packages* in
  `packages` -- from `nix-vscode-extensions` or `pkgs.vscode-extensions` -- and they are
  linked into the devShell window automatically. They install to
  `share/vscode/extensions/<id>`, which `nix develop` exposes through `XDG_DATA_DIRS`, so
  no new convention is needed; only entries the devShell added are considered, never the
  host's own. Pinned by flake.lock, nothing downloaded at activation.
- Links are kept in sync with the active devShell, so switching shells does not leave the
  previous one's extensions behind. Marketplace-installed extensions are never removed.
- `flake.nix` gained an `editor` devShell demonstrating both Nix packages and
  `vscodeExtensions` Marketplace IDs.

## 0.3.0

- **direnv co-existence.** When the flake directory has an `.envrc` that runs `use flake`
  or `use nix`, direnv already puts the devShell into every shell entering the directory.
  Applying it again duplicated every store path on PATH, so the environment is now left to
  direnv; the status bar says so. `nixDevelop.respectDirenv` turns this off, and
  "Reload environment" applies it anyway. A stale `.direnv/` with no `.envrc` is ignored.
- If `.envrc` names a different devShell than the workspace selects, that mismatch is now
  reported instead of the two silently disagreeing.
- **Shells that provide no interactive shell.** The terminal shell is picked in order:
  the devShell SHELL if it is usable, then the login shell, then any usable bash the
  devShell puts on PATH. A `SHELL = ...` attribute in mkShell does **not** survive -- the
  dev-env script overwrites it before the shellHook runs -- so a devShell that adds
  `bashInteractive` to packages is now handled without needing a shellHook.
- Extension-host PATH edits skip entries that are already present, so direnv's VS Code
  extension and this one no longer stack duplicates.

## 0.2.4

- The session-shell fix now defers to the devShell. SHELL is only replaced when it points
  at a bash that cannot serve as an interactive shell (no programmable completion, which
  is exactly the readline-less build `nix develop` puts on PATH). A devShell that sets
  SHELL itself -- `shellHook = "export SHELL=${pkgs.bashInteractive}/bin/bash"` -- keeps its
  choice, and a non-bash shell is never second-guessed.

## 0.2.3

- Terminals in a devShell window now use your own login shell. `nix develop` points SHELL
  at nixpkgs bash-minimal, which is built without readline, and VS Code used it for every
  terminal: no history, no line editing, no completion, and prompt markers printed
  literally as backslash-bracket. SHELL is session-owned -- the local environment filter
  already dropped it -- so the server launch now restores it too. The devShell environment
  is inherited exactly as before.

## 0.2.2

- Selecting a devShell now actually does something: in `auto`/`remote` mode it opens the
  devShell window instead of only writing a setting. Added `nixDevelop.mode` to choose
  between a devShell window and applying the environment in place.
- devShells can be switched from inside a devShell window. Previously the command reported
  "No flake.nix found" there, because a remote window has no local workspace folder.
- `nixDevelop.remote.isolateExtensions` now defaults to **false**, so devShell windows
  share one extension set the way Remote-SSH does. With isolation on and nothing seeded,
  a devShell window had none of your extensions, which looked like the environment having
  failed to apply even though the toolchain was present.
- Offers "Install Local Extensions..." once when a devShell window has no user extensions.
- "Show resolved environment" works inside a devShell window instead of claiming no
  devShell is active.
- Added an activation smoke test that executes `activate()` against a fake editor.

## 0.2.1

- **Flake evaluation is dramatically faster.** Local flakes are now addressed by a bare
  path instead of `path:<dir>`, so Nix uses the Git source and sees only tracked files. A
  `path:` ref hashes and copies the entire directory -- `node_modules`, `target/`, build
  outputs -- on every evaluation. On a 12 GB checkout with 800 tracked files, listing
  devShells went from not finishing within 60s to about 50ms. This affects `nix develop`
  too, not just the picker.
- Falls back to `path:` automatically when a flake.nix is not tracked by Git, and logs the
  `git add` command that would make it fast.
- The devShell list is cached against the mtime and size of flake.nix and flake.lock, and
  the Nix system double is remembered across windows, so reopening the picker is instant.
- The "evaluating flake" progress is now cancellable, and a slow evaluation explains why.

## 0.2.0

- **Real remote windows.** `Nix Develop: Reopen in devShell` implements a
  `RemoteAuthorityResolver`: the folder reopens on a `vscode-remote://nix-develop+…`
  authority and a VS Code server is started inside `nix develop`, so the remote extension
  host, terminals, tasks and debuggers run in the shell. Requires
  `--enable-proposed-api nix-develop.nix-develop`.
- **Per-devShell extension sets.** The server's `--extensions-dir` is scoped per devShell.
  Extensions can be declared in workspace settings or by the devShell itself through a
  `vscodeExtensions` list attribute on `mkShell`.
- Servers are reused across windows via a lock file and can be stopped with
  `Nix Develop: Stop devShell server`.
- On NixOS, the server's bundled glibc `node` is patched through the launcher's own
  `VSCODE_SERVER_CUSTOM_GLIBC_*` hooks, and only when it actually fails to start.
- Removed the `code tunnel` / `code serve-web` re-entry paths in favour of the resolver.

## 0.1.0

Initial release.

- Prompts to pick a devShell when a workspace containing `flake.nix` is opened.
- Persists the choice to workspace settings (`nixDevelop.devShell`).
- Builds the devShell and applies its environment to terminals, tasks, and the
  extension host.
- Pins each built shell with a Nix profile GC root.
