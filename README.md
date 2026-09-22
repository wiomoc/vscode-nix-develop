# VSCode Nix DevShell

Open a workspace that has a `flake.nix`, pick a devShell, and VS Code uses it — terminals,
tasks, debuggers and language servers all get the toolchain `nix develop` would have given
you.

![A Rust workspace: clicking the status bar picks the flake's devShell, the window reopens with its server inside `nix develop`, and rust-analyzer, Even Better TOML and the settings pointing at the shell's own binaries come with it](docs/demo.gif)

*The devShell above declares its own `rust-analyzer`, its own extensions and the settings
that point the editor at them.*

## What it does

1. On opening a workspace containing `flake.nix`, offers to pick a devShell.
2. Reopens the folder in a window whose VS Code **server runs inside `nix develop`**, the
   same way Dev Containers works. The remote extension host, its terminals, tasks,
   debuggers and language servers are children of that server, so they are in the devShell
   for real rather than approximated by copying environment variables around.
3. Gives each devShell its own extension set and settings, which the flake itself can
   declare.

This needs the `resolvers` proposed API — see [Requirements](#requirements).

## Install

The extension needs the `resolvers` proposed API, and the Marketplace cannot grant that to
a third-party extension — so however it is installed, the editor has to be told to allow
it. The Nix route does both in one place.

### As a NixOS module (recommended)

The flake exports `nixosModules.default`. It adds the extension to `programs.vscode` and
replaces the editor package with one that launches as
`--enable-proposed-api wiomoc.nix-devshell`, so there is nothing left to switch on:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-devshell.url = "github:wiomoc/vscode-nix-devshell";
  };

  outputs =
    { nixpkgs, nix-devshell, ... }:
    {
      nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          nix-devshell.nixosModules.default
          { programs.vscode.enable = true; }
          ./configuration.nix
        ];
      };
    };
}
```

`programs.vscode.enable` stays yours to set — the module contributes only the package and
the extension.

For an editor installed some other way, `overlays.default` carries just the launch
argument: applied to your nixpkgs it makes `pkgs.vscode` and `pkgs.vscode-fhs` start with
the proposed API enabled. The extension on its own is `packages.${system}.default`.

### From a `.vsix`

1. Download `nix-devshell-<version>.vsix` from
   [Releases](https://github.com/wiomoc/vscode-nix-devshell/releases).
2. Install it, with `code --install-extension nix-devshell-<version>.vsix` or from
   *Extensions → ⋯ → Install from VSIX…*.
3. Allow the proposed API for good, by adding the extension id to `argv.json` —
   **Preferences: Configure Runtime Arguments** opens it, or edit `~/.vscode/argv.json`
   directly (`~/.vscodium/argv.json` for VSCodium):

   ```jsonc
   {
     "enable-proposed-api": ["wiomoc.nix-devshell"]
   }
   ```

4. Quit VS Code entirely and start it again — `argv.json` is only read at launch.

## Commands

| Command | Description |
| --- | --- |
| `Nix DevShell: Reopen in devShell` | Reopen the folder with the extension host running inside the devShell |
| `Nix DevShell: Select devShell` | Switch the devShell a devShell window is running in; only offered inside one |
| `Nix DevShell: Reopen folder locally` | Leave a devShell window |
| `Nix DevShell: Show resolved environment` | Open the computed environment as a document |
| `Nix DevShell: Show devShell extensions (remote)` | What is installed in this devShell, and where each extension runs |
| `Nix DevShell: Restart devShell server` | Put the window back on a devShell built from the flake as it is now |
| `Nix DevShell: Stop devShell server` | Stop the server backing a devShell; run inside a devShell window, it leaves the folder in a local one |
| `Nix DevShell: Show log` | Open the output channel |

The status bar shows the active devShell; click it to switch. In a local window it reads
`devShell` with no name — a devShell is only ever active *inside* one of its windows — and
clicking it opens one, since that is what picking a devShell locally means.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nixDevShell.flakeDirectory` | `"."` | Where `flake.nix` lives, relative to the folder |
| `nixDevShell.promptWhenUnset` | `true` | Offer the picker when a workspace with a `flake.nix` opens |
| `nixDevShell.impure` | `false` | Pass `--impure` |
| `nixDevShell.extraArgs` | `[]` | Extra arguments for `nix develop` |
| `nixDevShell.nixPath` | `"nix"` | Path to the `nix` binary |
| `nixDevShell.buildTimeoutSeconds` | `1800` | Abort a build after this long |
| `nixDevShell.profile` | `"persistent"` | Keep a Nix GC root per devShell in `.vscode/nix-devshell/`, or `"none"` to root nothing |
| `nixDevShell.showBuildOutput` | `"always"` | Stream the devShell build into a terminal: `"always"`, `"onFailure"`, or `"never"` |
| `nixDevShell.remote.connectTimeoutSeconds` | `180` | How long to wait for the server to listen |
| `nixDevShell.remote.serverDownloadUrl` | `""` | Where to fetch the VS Code server; empty detects it from the editor's `product.json` |
| `nixDevShell.remote.patchServerLd` | `true` | Point the server's bundled `node` at a glibc from nixpkgs with `patchelf` |

## Per-devShell extensions

A remote window loads `workspace`-kind extensions from the **server's** extensions
directory, which this extension keeps per devShell. So a devShell can bring its own editor
tooling, declared in the flake itself — `mkShell` turns a Nix list attribute into a
space-separated environment variable:

```nix
devShells.default = pkgs.mkShell {
  packages = [ pkgs.rustc pkgs.cargo pkgs.rust-analyzer ];

  vscodeExtensions = [
    pkgs.vscode-extensions.tamasfe.even-better-toml   # a Nix package
    "rust-lang.rust-analyzer"                         # a Marketplace ID
  ];
};
```

Switching devShells switches the extension set, with nothing to uninstall. Details,
including `extensionKind` and the NixOS server-loader handling, are in
[docs/REMOTE.md](docs/REMOTE.md).

## Per-devShell settings

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
yourself are left alone.

## Extensions from Nix

An entry in `vscodeExtensions` is either a Marketplace ID or a Nix package, and the two mix
freely in one list. [`nix-vscode-extensions`](https://github.com/nix-community/nix-vscode-extensions)
packages almost every Marketplace and Open VSX extension as a derivation; `pkgs.vscode-extensions`
carries nixpkgs' own smaller curated set. Either is pinned by `flake.lock`, identical for
everyone, and downloads nothing when the window opens:

```nix
devShells.default =
  let marketplace = nix-vscode-extensions.extensions.${system}.vscode-marketplace;
  in pkgs.mkShell {
    packages = [ pkgs.rustc pkgs.cargo ];

    vscodeExtensions = [
      marketplace.rust-lang.rust-analyzer
      pkgs.vscode-extensions.tamasfe.even-better-toml
    ];
  };
```

Every devShell has its own extension directory, so the set matches what that shell declares:
switching devShells drops the links the new one does not ask for, and nothing another shell
installed leaks in. Extensions installed from the Marketplace by hand are never removed.

`flake.nix` in this repository has a working `editor` devShell demonstrating both forms.

## Compared with the alternatives

Three ways to get a devShell into VS Code:

| | Approach |
| --- | --- |
| **A** | **This extension** — the VS Code *server* runs inside `nix develop`; the window connects to it |
| **B** | **direnv** — `.envrc` with `use flake`, plus the direnv extension, which copies the variables into the running editor |
| **C** | **Launch from the shell** — each devShell packages its own `pkgs.vscode-with-extensions`, started as `nix develop .#x --command code --user-data-dir <per-shell dir> .` |

🟢 strong · 🟡 partial, or conditional on discipline · 🔴 weak or absent

| | **A. This extension** | **B. direnv** | **C. Launch from the shell** |
| --- | --- | --- | --- |
| **Packages, env vars** | 🟢 Terminals, tasks, debuggers and language servers are children of a server started by `nix develop` — inherited, not copied. | 🟡 Variables are copied into the running extension host. Whatever read the environment before direnv applied it keeps stale values. | 🟢 The whole editor is inside the shell, client and `ui` extensions included. Frozen at launch: a `flake.nix` change needs a restart. |
| **Extensions per devShell** | 🟢 Own extensions directory per (folder, devShell), declared in the flake as IDs or `nix-vscode-extensions` derivations. Stays writable, so ad-hoc installs still work; `ui` extensions stay host-side. | 🔴 One global set shared by every project. The flake cannot express an extension at all. | 🟢 Every extension pinned, `ui` included. The directory is a read-only store path, so nothing can be installed ad hoc and your theme has to live in the project's flake. |
| **Switching devShell** | 🟢 Status bar picker; reopens the window and swaps the extension set with it. | 🟡 Edit `.envrc`, `direnv allow`, reload the window. One shell per file. | 🔴 Out to a terminal, a new instance every time. |
| **Several windows open** | 🟢 A server, extension host and extensions directory per devShell window. The devShell is encoded in the window's authority, so *Recent* reopens it on the same one. | 🟡 Environment is per window; the extension set is global. | 🟡 Separate instances share nothing — but *Open Folder* or *Recent* inside one silently reuses that instance's shell and extensions. |
| **Runtime cost, N shells** | 🟡 One Node server per devShell in active use; an idle one exits five minutes after its last window disconnects. Single shared client. | 🟢 Nothing per shell. | 🔴 A full Electron instance per shell. |
| **VS Code version** | 🟡 Your own install, unpinned — only the server is pinned to its commit. The server build is whichever your editor declares, so VSCodium works too (via its REH builds, with Open VSX for extensions). | 🔴 Your own install, unpinned. | 🟢 The editor binary comes from `flake.lock`, and two shells may sit on different versions. |
| **Settings, keybindings, logins** | 🟢 One profile across local and devShell windows; sign in once. | 🟢 One profile. | 🔴 One profile per devShell: separate settings and credential store, every login repeated. |
| **Setup and upkeep** | 🟡 Needs `--enable-proposed-api wiomoc.nix-devshell` in `argv.json`, and proposed APIs can break between releases. Nothing added to the repository. | 🔴 direnv, nix-direnv, the extension, a committed `.envrc` and a `direnv allow` per clone — but that same `.envrc` also serves plain shells, other editors and CI. | 🔴 An editor build per devShell, a user data directory per devShell to name, gitignore and prune, and a launch line that must never be shortened: drop `--user-data-dir` once and the folder is handed to the running instance with the wrong shell and the wrong extensions, silently. |

## Requirements

- Nix with flakes. The extension passes
  `--extra-experimental-features 'nix-command flakes'` itself, so enabling them globally is
  not required.
- VS Code 1.85 or newer.
- The `resolvers` proposed API, which is what lets an extension resolve a remote authority:

  ```bash
  code --enable-proposed-api wiomoc.nix-devshell
  ```

  Without it there is nothing to fall back to, and the extension says so rather than
  failing later. [Install](#install) sets this up permanently, either way round.

The extension does not activate in an untrusted workspace: evaluating a flake runs
arbitrary Nix code and shell hooks from the repository.

## Documentation

- [docs/REMOTE.md](docs/REMOTE.md) — how a devShell window is opened, end to end: the
  authority, the server, per-devShell extensions and settings, and the limitations.
- [architecture/](architecture/) — a class diagram of every module and type, and a sequence
  diagram of a devShell window starting up.

## Development

```bash
nix develop            # or: npm install
npm run build
npm test               # unit tests (Vitest); the end-to-end ones report as skipped
npm run test:watch     # the same, re-running what a change touches
npm run test:e2e       # also drives the real nix CLI (needs network, slow on a cold store)
npm run typecheck      # src and test
npm run package        # produces a .vsix
```

Tests live in [test/](test/) and run under [Vitest](https://vitest.dev) in plain Node: the
`vscode` module only exists inside the editor, so [vitest.config.mts](vitest.config.mts)
aliases it to [test/activation-stub.ts](test/activation-stub.ts).
Press <kbd>F5</kbd> to launch an Extension Development Host.

## License

MIT
