# Nix Develop

Open a workspace that has a `flake.nix`, pick a devShell, and VS Code uses it — terminals,
tasks, debuggers and language servers all get the toolchain `nix develop` would have given
you.

## What it does

1. On opening a workspace containing `flake.nix`, offers to pick a devShell.
2. Reopens the folder in a window whose VS Code **server runs inside `nix develop`**, the
   same way Dev Containers works. The remote extension host, its terminals, tasks,
   debuggers and language servers are children of that server, so they are in the devShell
   for real rather than approximated by copying environment variables around.
3. Gives each devShell its own extension set, which the flake itself can declare.

The choice is not written anywhere: it takes effect by opening the window, and that
window's remote authority is what remembers it — so reopening the window, restoring it
after a restart, or picking it out of "recently opened" all keep the same devShell. There
is no setting that pins one, because there is nothing for a setting to pin. A project that
wants to state which shell it means can say so in `.envrc` (`use flake .#ci`), and the
picker offers that one first.

This needs the `resolvers` proposed API — see [Requirements](#requirements).

## Commands

| Command | Description |
| --- | --- |
| `Nix Develop: Select devShell` | Pick from the flake's `devShells.<system>` |
| `Nix Develop: Show resolved environment` | Open the computed environment as a document |
| `Nix Develop: Reopen in devShell` | Reopen the folder with the extension host running inside the devShell — see [docs/REMOTE.md](docs/REMOTE.md) |
| `Nix Develop: Reopen folder locally` | Leave a devShell window |
| `Nix Develop: Show devShell extensions (remote)` | What is installed in this devShell, and where each extension runs |
| `Nix Develop: Stop devShell server` | Stop the server backing a devShell |
| `Nix Develop: Show log` | Open the output channel |

The status bar shows the active devShell; click it to switch. In a local window it reads
`devShell` with no name — a devShell is only ever active *inside* one of its windows.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nixDevelop.flakeDirectory` | `"."` | Where `flake.nix` lives, relative to the folder |
| `nixDevelop.promptWhenUnset` | `true` | Offer the picker when a workspace with a `flake.nix` opens |
| `nixDevelop.impure` | `false` | Pass `--impure` |
| `nixDevelop.extraArgs` | `[]` | Extra arguments for `nix develop` |
| `nixDevelop.nixPath` | `"nix"` | Path to the `nix` binary |
| `nixDevelop.buildTimeoutSeconds` | `1800` | Abort a build after this long |
| `nixDevelop.profile` | `"persistent"` | Keep a Nix GC root per devShell in `.vscode/nix-develop/`, or `"none"` to root nothing |
| `nixDevelop.remote.extensions` | `[]` | Extension IDs to install into the devShell |
| `nixDevelop.remote.extensionsFromFlake` | `true` | Also read `vscodeExtensions` from the devShell |
| `nixDevelop.remote.settings` | `{}` | Editor settings to apply inside the devShell window |
| `nixDevelop.remote.settingsFromFlake` | `true` | Also read `vscodeSettings` from the devShell |
| `nixDevelop.remote.connectTimeoutSeconds` | `180` | How long to wait for the server to listen |
| `nixDevelop.remote.serverDownloadUrl` | update.code.visualstudio.com | Where to fetch the VS Code server |
| `nixDevelop.remote.patchServerLd` | `true` | Point the server's bundled `node` at a glibc from nixpkgs with `patchelf` |

## Architecture

[architecture/](architecture/) has a class diagram of every module and type, and a
sequence diagram of a devShell window starting up, from the picker through to the server
running inside `nix develop`.

## How the environment is captured

The naive approach — `nix print-dev-env --json` — gives you the *build* environment, not
the shell you would get interactively. It reports `HOME=/homeless-shelter`, `TMPDIR=/build`,
and hands back `shellHook` as an unexecuted string. Exporting that into a terminal is
wrong in several ways at once.

Instead this extension runs the environment dump *through* `nix develop`, which is what a
user typing `nix develop` gets:

```
nix develop <installable> --profile <gcroot> --command bash -c '<dump>' <outfile>
```

(`--profile` is dropped when `nixDevelop.profile` is `"none"`.)

Details that matter:

- **The dump goes to a file, not stdout.** Shell hooks routinely print banners, and
  `nix develop` itself writes notices such as `setting SOURCE_DATE_EPOCH`. Anything on
  stdout would corrupt the payload.
- **Variables are NUL-delimited**, so values containing newlines or `=` survive.
- **`env -0` with a pure-bash fallback.** `nix develop` puts nixpkgs' *minimal* bash on
  `PATH`, which is built without programmable completion, so `compgen` does not exist;
  and a devShell may leave coreutils off `PATH` entirely. The fallback parses only the
  variable *names* out of `export -p` and reads each value back by indirect expansion.
- **A baseline is captured the same way** without the devShell, so only the shell's actual
  contribution is applied.
- **Search paths are prepended, not replaced.** `nix develop` appends the host `PATH`, so
  the devShell's contribution is a strict prefix. Prepending just that prefix means entries
  your own shell profile adds later are preserved.
- **stdenv internals are filtered out.** `out`, `builder`, `phases`, `shellHook`, `name`,
  `stdenv`, the `deps*` attributes and friends are derivation plumbing, not environment.
  Session-owned variables (`HOME`, `SHELL`, `TMPDIR`, `PWD`, `SSH_*`, `VSCODE_*`) are left
  alone too — in particular `TMPDIR`, which points at a scratch directory that will not
  exist by the time you use the terminal.

Run `Nix Develop: Show resolved environment` to see exactly what was computed, including
what was filtered.

## Why it is fast

Local flakes are addressed by a **bare path**, never `path:<dir>`. That distinction matters
more than it looks: a bare path lets Nix notice the directory is a Git work tree and use
the Git source, which contains only tracked files. A `path:` ref instead hashes and copies
the whole directory -- `node_modules`, `target/`, `result`, build outputs -- on every
evaluation, and a churning untracked tree also defeats the Nix eval cache.

On a 12 GB checkout with ~800 tracked files, listing devShells takes about 50ms with the
Git source and does not finish within a minute with `path:`. The same applies to
`nix develop`, so it is the build path too, not just the picker.

If a flake.nix is not tracked by Git, Nix refuses to see it through the Git source; the
extension falls back to `path:` automatically and logs the `git add` that would make it
fast. A flake outside any Git repository has no source filtering available at all -- there
Nix must hash the directory, and a slow evaluation says so.

On top of that, the devShell list is cached against the mtime and size of flake.nix and
flake.lock, and the Nix system double is remembered across windows.

## direnv

A devShell window takes its environment from the server running inside `nix develop`, so
direnv and this extension no longer contend for the terminal — there is nothing to
double-apply.

What still matters is *which* devShell each one picked. A plain terminal outside the window
follows `.envrc`, so a shell it names — `use flake .#ci` — is the project's own statement of
which one it means, and the picker marks it and offers it first. It is a default, not a
decision: the picker still lists every shell the flake has.

## Which shell terminals use

`nix develop` points `SHELL` at the bash it puts on `PATH`, which is nixpkgs' **minimal**
build: no readline, so no history, no line editing, no completion, and prompt markers
printed literally as `\[` and `\]`. Editors pick the terminal shell from `SHELL`.

For a devShell window the shell is chosen in this order:

1. the devShell's own `SHELL`, if it can actually serve as an interactive shell;
2. your login shell;
3. any usable bash the devShell puts on `PATH`.

So a devShell needs no special handling. To fix it at the source, note that a plain
attribute does **not** work -- the dev-env script sets `SHELL` from stdenv *before*
evaluating the hook, so only a `shellHook` survives:

```nix
pkgs.mkShell {
  packages = [ pkgs.bashInteractive ];          # puts a real bash on PATH
  shellHook = ''
    export SHELL=${pkgs.bashInteractive}/bin/bash   # ...and makes it the shell
  '';
}
```

That also fixes plain `nix develop` and direnv, not just this extension.

## How it works

`Nix Develop: Reopen in devShell` reopens the folder on a `vscode-remote://nix-develop+…`
authority. The extension implements a `RemoteAuthorityResolver` — the mechanism Dev
Containers and Remote-SSH use — and starts a VS Code server inside `nix develop`, then
points the window at it.

That requires the `resolvers` proposed API:

```bash
code --enable-proposed-api nix-develop.nix-develop
```

Without it there is nothing to fall back to, and the extension says so rather than failing
later. [docs/REMOTE.md](docs/REMOTE.md) has the full mechanism.

### Per-devShell extensions

A remote window loads `workspace`-kind extensions from the **server's** extensions
directory, which this extension keeps per devShell. So a devShell can bring its own editor
tooling, declared in the flake itself — `mkShell` turns a Nix list attribute into a
space-separated environment variable:

```nix
devShells.default = pkgs.mkShell {
  packages = [ pkgs.rustc pkgs.cargo pkgs.rust-analyzer ];
  vscodeExtensions = [ "rust-lang.rust-analyzer" "tamasfe.even-better-toml" ];
};
```

Switching devShells switches the extension set, with nothing to uninstall. Details,
including `extensionKind` and the NixOS server-loader handling, are in
[docs/REMOTE.md](docs/REMOTE.md).

### Per-devShell settings

A pinned extension is of little use if the editor still points at a binary from the host,
so a devShell can declare the settings that go with its toolchain. Derivation attributes
are strings, so an attrset is spelled as JSON:

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

The path is the store path of the package the devShell already provides — the setting is as
reproducible as the tool it names. A `key=value` per line works too, for simple values.

These land in the devShell server's *machine* settings, so they apply to that devShell's
window and nowhere else, they outrank your user settings, and the workspace's own
`.vscode/settings.json` still wins over them. Nothing is written into the workspace. Keys
the flake stops declaring are removed on the next open; keys you added to that file
yourself are left alone. `nixDevelop.remote.settings` is the per-checkout equivalent, and
beats the flake where both name the same key.

### Extensions from Nix

[`nix-vscode-extensions`](https://github.com/nix-community/nix-vscode-extensions) packages
almost every Marketplace and Open VSX extension as a Nix derivation (`pkgs.vscode-extensions`
carries a smaller curated set). Put one in a devShell's `packages` and it is picked up
automatically — pinned by `flake.lock`, identical for everyone, with nothing downloaded when
the window opens:

```nix
devShells.default =
  let marketplace = nix-vscode-extensions.extensions.${system}.vscode-marketplace;
  in pkgs.mkShell {
    packages = [
      pkgs.rustc
      pkgs.cargo
      marketplace.rust-lang.rust-analyzer
      marketplace.tamasfe.even-better-toml
    ];
  };
```

No extra convention is needed: these packages install to
`$out/share/vscode/extensions/<publisher>.<name>`, and `nix develop` puts `$out/share` on
`XDG_DATA_DIRS`. The extension reads the entries the devShell *added* — never the host's own
VS Code install — and symlinks them into the server's extension directory.

Every devShell has its own extension directory, so the set matches what that shell declares:
switching devShells drops the links the new one does not ask for, and nothing another shell
installed leaks in. Extensions installed from the Marketplace are never removed.

Switching devShells inside a devShell window also stops the server it leaves behind, so its
extension host does not linger with the previous shell's extensions loaded.

`flake.nix` in this repository has a working `editor` devShell demonstrating both this and
the `vscodeExtensions` ID list.

## Development

```bash
nix develop            # or: npm install
npm run build
npm test               # unit tests
npm run test:e2e       # also drives the real nix CLI (needs network, slow on a cold store)
npm run package        # produces a .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

## Requirements

- Nix with flakes. The extension passes
  `--extra-experimental-features 'nix-command flakes'` itself, so enabling them globally is
  not required.
- VS Code 1.85 or newer.

The extension does not activate in an untrusted workspace: evaluating a flake runs
arbitrary Nix code and shell hooks from the repository.

## License

MIT
