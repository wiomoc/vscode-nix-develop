# Reopening a workspace inside a devShell

This extension implements a **`RemoteAuthorityResolver`** — the same mechanism Dev
Containers, Remote-SSH and WSL use. `Nix Develop: Reopen in devShell` reopens the folder on
a `vscode-remote://nix-develop+<id>/…` authority, and the resolver starts a VS Code
**server** inside `nix develop`. The remote extension host, its terminals, tasks, debuggers
and language servers are all children of that server, so they are inside the devShell for
real rather than approximated by patching environment variables.

For the same flow as a diagram, see
[../architecture/startup-sequence.md](../architecture/startup-sequence.md).

## Requirement: proposed API

`resolvers` is a proposed API. Stock VS Code grants it only to an allowlist in
`product.json` (`ms-vscode-remote.remote-ssh`, `remote-wsl`, `remote-containers`,
`ms-vscode.remote-server`, `GitHub.codespaces`, …). A third-party extension must be
allowlisted at launch:

```bash
code --enable-proposed-api nix-develop.nix-develop
```

Make it permanent by adding the extension id to `argv.json`
(**Preferences: Configure Runtime Arguments**):

```jsonc
{
  "enable-proposed-api": ["nix-develop.nix-develop"]
}
```

Without the flag the extension still loads and everything else works; it logs that the
resolver could not be registered and `Reopen in devShell` will fail to resolve. The
registration is guarded by a capability check, so a stock editor never sees an error.

Proposed APIs carry no compatibility guarantee and can change between VS Code releases.
`src/vscode.proposed.resolvers.d.ts` is pinned to the shape this was built against.

## What happens on reopen

1. The command encodes `{ folder, flakeDir, devShell }` into the authority itself and calls
   `vscode.openFolder` on `vscode-remote://nix-develop+<payload>/<path>`. The resolver runs
   in a **different window** and is handed nothing but that string, so the authority *is*
   the mapping — there is no side table to consult or to lose.
2. VS Code opens the new window and calls `resolve()`.
3. The resolver:
   - reuses a live server if the lock file for that authority names a pid that is still
     alive and a port that still accepts connections;
   - otherwise ensures a server distribution matching `vscode.env.appCommit` is on disk,
     reusing one another feature already downloaded for that commit (Remote-SSH's
     `~/.vscode-server/bin/<commit>`, or the CLI's `servers/<quality>-<commit>/server`)
     before falling back to downloading;
   - installs the devShell's declared extensions into its extensions directory;
   - spawns `nix develop <installable> --command <server>/bin/code-server --start-server
     --host 127.0.0.1 --port 0 --connection-token <uuid> …`, detached;
   - parses `Extension host agent listening on <port>` and returns
     `new ResolvedAuthority("127.0.0.1", port, token)`.

### Why the authority is base32, not a digest

The payload is `<folder>\0<devShell>` (plus `flakeDir` when it differs), base32-encoded in
lower case. A digest would be shorter, but it only *names* the target — something else then
has to remember what it means, and an entry in "recently opened" can outlive that memory.
Encoding the target removes the side table entirely.

The encoding has to be **case-insensitive**, which is why it is base32 and not the denser
base64url. A URI authority is case-insensitive by RFC 3986, and VS Code acts on it
inconsistently in a way that matters:

| how the window is opened | authority |
| --- | --- |
| `--remote` on the command line | preserved verbatim |
| restored from persisted state after a restart | **lower-cased** |

So a base64 payload resolves fine until the editor is restarted, and then silently stops —
it decodes to mojibake and the window cannot reconnect. base32's alphabet is a single case,
so it round-trips through the fold unchanged. There is a test asserting that an authority
equals its own lower-casing and still decodes.

The authority is *not* used as a file name: it grows with the folder path and a deep enough
checkout would exceed the 255-byte limit on a path component. Server data, the extension
directory and the lock file are keyed by a 16-character hash of it instead.

## Which server, for which editor

Nothing here is written against Microsoft's build specifically. Which server to fetch, and
what its launcher is called, are read from the running editor's own `product.json` at
`vscode.env.appRoot` -- so the answer comes from the editor rather than from a list of
products this extension knows about.

| | Microsoft | VSCodium |
|---|---|---|
| `serverApplicationName` | `code-server` | `codium-server` |
| `serverDataFolderName` | `.vscode-server` | `.vscodium-server` |
| `dataFolderName` | `.vscode` | `.vscode-oss` |
| `serverDownloadUrlTemplate` | absent | its own GitHub release |
| archive layout | one `vscode-server-<platform>/` wrapper | no wrapper |

VSCodium publishes a REH (remote extension host) build per release and points at it from
`product.json`, fully resolved down to the release tag, so it needs no configuration. A
Microsoft build declares no template -- the URL lives in its CLI, not its `product.json` --
so `update.code.visualstudio.com` stands in. `nixDevelop.remote.serverDownloadUrl` overrides
both when set.

The archive layout is not declared anywhere, so it is detected rather than configured: the
tarball is unpacked flat, and the distribution is then found either at the top or inside a
single wrapper directory. Reading `--strip-components` off the product would be one more
thing to get wrong for the next rebuild.

The resolver runs on the *client* side, which is what makes reading `appRoot` correct: a
devShell window's own extension host sees an `appRoot` inside the server, whose
`product.json` describes the server rather than the editor that has to match it.

The server binds to loopback with a random per-start connection token. It is detached on
purpose, so closing the window does not kill it -- the next window attaches to it instead of
paying for a fresh `nix develop`.

It does not outlive its usefulness, though. It is started with `--enable-remote-auto-shutdown`,
so five minutes after its last extension host disconnects it exits by itself; an extension
host that reconnects inside that window cancels the shutdown, which is what makes reloads,
restarts and reopens land on the same server. The same timer starts when the server boots,
so one that is started and then never connected to is collected too. `Nix Develop: Stop
devShell server` ends one immediately.

Nothing of ours runs inside the devShell alongside the server. `nix develop --command`
*execs*, so the launcher is the process the extension spawned; there is no shell of ours
between the two, and nothing to inherit the extension's environment and leak it into every
terminal the window opens.

The cost is that a server which retires itself cannot tidy up after itself: it leaves its
lock file behind. That is deliberate, and harmless. A lock is a claim about a port, and
every reader tests the port before believing it, so a lock whose server is gone is inert
rather than wrong -- it can neither hijack a window nor block a new server. Cleaning it up
is the extension's job, in three places, all idempotent:

- `ServerManager.sweep`, at activation, across every devShell at once. This is what
  collects the servers that retired while no editor was running.
- `findRunning`, when the lock it is about names a port nothing answers on.
- `ServerManager.stop`, for an explicit `Stop devShell server`. Run from inside the window
  that server was backing, this also puts the folder back in a local window: the server was
  that window's extension host and file system, so there is nothing left for it to show.

None of them touch the devShell's GC root: a profile under `.vscode/nix-develop/` belongs
to the project and outlives every server that enters it.

`getCanonicalURI` maps `vscode-remote://nix-develop+…/x` back to `file:///x`. A devShell
shares the machine's filesystem, so without it VS Code would treat the same file opened
locally and remotely as two different resources.

## Scoping extensions to a single devShell

This falls out of the architecture. A remote window loads `workspace`-kind extensions from
the **server's** `--extensions-dir`, not from the local install — so pointing that
directory at a per-devShell path is all it takes. Two devShells in one repository get
genuinely separate extension sets, and neither disturbs the local window. Every devShell
gets its own directory, keyed by folder + devShell name, so this is simply how it works —
there is no shared mode to opt out of.

Which extensions belong to a devShell can be declared in two places.

### In the flake — the interesting one

`mkShell` turns a Nix **list attribute** into a space-separated environment variable, so a
devShell can name its own editor extensions:

```nix
devShells.default = pkgs.mkShell {
  packages = [ pkgs.rustc pkgs.cargo pkgs.rust-analyzer ];

  # Becomes vscodeExtensions="rust-lang.rust-analyzer tamasfe.even-better-toml"
  vscodeExtensions = [
    "rust-lang.rust-analyzer"
    "tamasfe.even-better-toml"
  ];
};
```

The toolchain and the editor support for it are then declared, versioned and reviewed in
the same expression. Reopening in that devShell installs them into its own extensions
directory; switching to a `devShells.docs` that declares a Markdown toolchain gets a
different set, with no uninstalling in between.

Ids are validated against `publisher.name[@version]` before they reach
`--install-extension`, and a failed install warns rather than blocking the window.

### From Nix — pinned and prebuilt

A devShell can supply extensions as Nix packages instead of Marketplace IDs, via
[`nix-vscode-extensions`](https://github.com/nix-community/nix-vscode-extensions) or
`pkgs.vscode-extensions`:

```nix
let marketplace = nix-vscode-extensions.extensions.${system}.vscode-marketplace;
in pkgs.mkShell {
  packages = [ marketplace.jnoortheen.nix-ide marketplace.tamasfe.even-better-toml ];
}
```

Such a package installs to `$out/share/vscode/extensions/<publisher>.<name>`, and putting it
in `packages` makes `$out/share` appear in `XDG_DATA_DIRS` — so discovery needs no new
convention. Only the `XDG_DATA_DIRS` entries the devShell *added* are scanned, since the
host's own entries may point at an existing VS Code installation that the flake did not
declare. Each extension found is symlinked into the server's extension directory, which the
server accepts directly and records in its own `extensions.json`.

Because they are symlinks, they cost nothing to "install" and are pinned by `flake.lock`.
The set is re-synced whenever a server starts, and extensions the devShell no longer
declares are unlinked, so what is there is what the flake asks for. Removal is safe because
the directory belongs to one devShell and a sync only runs when that devShell has no server
— nothing can be pulled out from under a live extension host. A version bump retargets the
link rather than dropping it, so an extension is never left without files, and a real
directory (anything installed from the Marketplace) is never removed.

Switching devShells from inside a devShell window also stops the server being left behind.
That window was its only client, and its extension host still has the previous shell's
extensions activated; shutting it down releases it and guarantees the next visit starts from
what the flake declares now.

### Which side an extension runs on

Whether an extension lands in the devShell at all is decided by its `extensionKind`:

| Kind | Runs | Typical |
| --- | --- | --- |
| `workspace` | in the devShell | language servers, linters, debuggers, test runners |
| `ui` | locally | themes, keymaps, window chrome |

Extensions that declare both prefer `ui`. Override per extension with the standard
`remote.extensionKind` setting, which takes effect in the devShell window:

```jsonc
{ "remote.extensionKind": { "some.extension": ["workspace"] } }
```

`Nix Develop: Show devShell extensions (remote)` prints the server's extensions directory,
what is installed in it, what each source declared, and where every loaded extension is
currently running.

## Scoping settings to a single devShell

An extension pinned by the flake is only half the story: if the editor still points at a
binary from the host, the devShell's toolchain is present and unused. So a devShell can
declare editor settings the same way it declares extensions.

### In the flake

Derivation attributes are strings, so an attrset has to be spelled as JSON — which is what
`builtins.toJSON` is for:

```nix
devShells.default = pkgs.mkShell {
  packages = [ pkgs.nil pkgs.nixfmt ];

  vscodeSettings = builtins.toJSON {
    "nix.enableLanguageServer" = true;
    "nix.serverPath" = "${pkgs.nil}/bin/nil";
    "nix.formatterPath" = "${pkgs.nixfmt}/bin/nixfmt";
  };
};
```

The path is the store path of the very package the devShell provides, so the setting is as
reproducible as the toolchain it names, and no checkout has to carry a machine-specific
path.

A plain `key=value` per line is accepted too, for settings that do not need JSON:

```nix
vscodeSettings = ''
  python.defaultInterpreterPath=${pkgs.python3}/bin/python3
  editor.formatOnSave=true
'';
```

Values are read as JSON where they parse as JSON (`true`, `42`, `["a"]`) and as strings
otherwise, which is what keeps a store path intact. A list attribute works as well, since
it arrives as one space-separated line and every word is a pair; a line whose words are
*not* all pairs is one setting whose value may contain spaces.

### Where they land

In the server's **machine settings**, `<server-data-dir>/data/Machine/settings.json` —
which is per devShell, because the data directory is. That file is what VS Code shows as
the `Remote [devShell]` settings tab, and it sits between your user settings and the
workspace's own `.vscode/settings.json`:

```
workspace (.vscode/settings.json)   >   remote/machine   >   user
```

So a devShell can point the editor at its tools without overriding anything the repository
deliberately committed, and without writing to the workspace at all. Settings scoped
`application` (`update.mode`, `window.titleBarStyle`) are the exception: VS Code reads
those only from local user settings and ignores them here.

Only keys we declared are ours. Anything else in that file — including edits you make in
the settings UI — is left alone, and a key the flake *stops* declaring is removed again on
the next open, so deleting a line from the flake actually takes effect. The file is only
rewritten when the effective settings change, so hand-written comments survive.

Keys that do not look like settings keys are refused with a warning, and a malformed
`vscodeSettings` costs the settings, not the window.

`Nix Develop: Show devShell extensions (remote)` lists the machine settings file and the
keys currently in it, alongside the extensions.

## Window labelling

Two `ResourceLabelFormatter`s are registered: a `nix-develop+*` fallback, and -- in a devShell
window -- one bound to that window's exact authority which names the shell, so the title reads
`my-project [devShell: ci]`. `default` is left unnamed (`[devShell]`), since it is what a bare
`nix develop` picks.

The exact-authority formatter wins because `findFormatting` prefers the longest matching
authority pattern, and a full authority is far longer than `nix-develop+*`.

## The server's bundled `node`

The VS Code server ships a glibc-linked `node`. NixOS has no `/lib64/ld-linux-x86-64.so.2`,
so it cannot start unless `programs.nix-ld` is enabled.

The fix is `patchelf` and a glibc from nixpkgs, and `ServerManager.patchServerNode` runs it
from the extension before anything runs the launcher.
`nixDevelop.remote.patchServerLd` (default `true`) is the only switch: turned off, neither
the binary nor the environment is touched and no nixpkgs attribute is evaluated at all --
the only way this costs nothing on a cold store. That is for a host where the bundled `node`
already runs: `programs.nix-ld` enabled, or simply not NixOS.

### Why the extension patches, and not `bin/code-server`

The launcher will patch its own `node` when given `VSCODE_SERVER_CUSTOM_GLIBC_LINKER`,
`VSCODE_SERVER_CUSTOM_GLIBC_PATH` and `VSCODE_SERVER_PATCHELF_PATH`. Those hooks are
deliberately not used, because the variables stay in the environment the launcher hands to
`node`, and the server reports itself as running on an unsupported OS whenever the first one
is set:

```js
// out/server-main.js
isUnsupportedGlibc = (glibcVersion ? minorOf(glibcVersion) : 28) <= 27
  || !!process.env.VSCODE_SERVER_CUSTOM_GLIBC_LINKER;
```

The client turns that into a banner in every devShell window — *"You are connected to an OS
version that is unsupported by Visual Studio Code"* — which is backwards here: the glibc
patched in is newer than the 2.28 the check is worried about. Microsoft's flag means "this
server was made to run on an old distro"; ours means "this server was made to run on NixOS
at all". The launcher also rewrites `node` where it lies, so the `Text file busy` case below
is not handled: it prints its failure, execs the unpatched binary anyway, and only works
where `programs.nix-ld` happens to cover for it.

### How the patch is applied

Patching is idempotent: the current interpreter and RPATH are read back first
(`patchelf --print-interpreter`, `--print-rpath`) and a `node` that already points at the
right store paths is left alone, so almost every resolve finds the work already done.

When there is work to do, a copy is patched and renamed over the original rather than the
binary being rewritten where it lies. Servers outlive the window that started them and
every devShell on the same commit shares one distribution, so a `node` from that exact file
is usually running -- and Linux refuses to write to a running executable: `patchelf` fails
with `open: Text file busy`. A rename swaps only the directory entry, so the running
servers keep the inode they started on and the next one gets the patched binary.

A machine running this extension has Nix, so the builds are cached after the first, and
patching a `node` that would have started anyway changes nothing at runtime. The old `auto`
mode spent a `/etc/NIXOS` stat and a `node --version` spawn on every resolve to decide
something a devShell user nearly always wants; `patchServerLd: false` is the explicit
version of the answer it was guessing at.

Two details the old `auto` mode had been hiding, both found when patching stopped being
conditional:

- The linker comes from `nixpkgs#glibc.out`, not `nixpkgs#glibc`. The bare attribute
  resolves to glibc's **bin** output, which contains no `ld-linux-*` at all; patching
  against it reports success and then leaves a `node` that cannot exec at all:
  `cannot execute: required file not found`.
- The RPATH is set with `patchelf --set-rpath`, which **replaces** node's RPATH rather than
  extending it. glibc alone therefore breaks a node that was working, because it also links
  libstdc++: `libstdc++.so.6: cannot open shared object file`. The value is a
  colon-separated list of `nixpkgs#glibc.out` and `nixpkgs#gcc-unwrapped.lib`, and it is
  written *before* the interpreter — patchelf can grow the binary while setting an RPATH,
  which has been seen to undo an interpreter written first.

The glibc that stands in is whatever the flake registry's `nixpkgs` carries, and it is not
checked against the release the distribution's `node` was built for (**2.28** on today's
`linux-x64` server). glibc keeps its old symbol versions for ever, so anything at or above
that release gives `node` exactly the ABI it was built for; an *older* nixpkgs is the only
case that fails, and it fails at exec time with `node: /nix/store/...: version 'GLIBC_2.38'
not found`. Point the registry entry at a newer nixpkgs, or turn `patchServerLd` off.

The ELF interpreter is named per architecture, so the name is derived rather than fixed:

| `process.arch` | interpreter |
| --- | --- |
| `x64` | `ld-linux-x86-64.so.2` |
| `arm64` | `ld-linux-aarch64.so.1` |

Both come from nixpkgs' own `stdenv.cc.bintools.dynamicLinker` for the matching system.
`nixpkgs#glibc.out` resolves per system on its own, so an `aarch64-linux` machine builds its
own glibc with no further help.

`armv7l` is absent on purpose: nixpkgs spells its linker `ld-linux*.so.3`, an unresolved
glob, so there is no single name to hardcode. An architecture with no entry throws, naming
it, and the computed path is checked for existence before it is handed over — both beat
letting `patchelf` write an interpreter that nothing can load.

macOS is not supported here: `nixpkgs#glibc` does not build on darwin at all.

## Limitations

- Requires `--enable-proposed-api`, so it cannot be shipped enabled through the Marketplace.
- On a Microsoft build the server is a Microsoft build under the VS Code Server license;
  `--accept-server-license-terms` is passed on your behalf. VSCodium carries no server
  licence at all (`serverLicense` is empty), and the flag is accepted and inert there.
- VSCodium extensions come from Open VSX, because that is the gallery its server is built
  with. Anything published only to the Microsoft Marketplace cannot be installed into a
  devShell window under VSCodium.
- One server per (folder, devShell). Changing the flake does not restart it — use
  `Stop devShell server`, then reopen. That applies to `vscodeSettings` too: they are
  written just before a server starts.
- The devShell is built when the server starts. A cold build shows progress in the
  resolving notification and is bounded by `nixDevelop.remote.connectTimeoutSeconds`.

## If you cannot use proposed API

There is no fallback. Opening a devShell window is the only thing this extension does with a
selected devShell, so without `--enable-proposed-api` it will discover devShells and record
your choice but cannot act on it, and says so on activation.

Earlier versions applied the devShell's environment to the current window instead. That was
removed: it covered terminals and tasks but never the extensions already activated in the
window, so it was a second, weaker code path that behaved subtly differently from the real
thing. `direnv` remains the better tool for putting a devShell into a plain shell.
