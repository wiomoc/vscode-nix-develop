# Comparison

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
| **Setup and upkeep** | 🟡 Needs `--enable-proposed-api nix-develop.nix-develop` in `argv.json`, and proposed APIs can break between releases. Nothing added to the repository. | 🔴 direnv, nix-direnv, the extension, a committed `.envrc` and a `direnv allow` per clone — but that same `.envrc` also serves plain shells, other editors and CI. | 🔴 An editor build per devShell, a user data directory per devShell to name, gitignore and prune, and a launch line that must never be shortened: drop `--user-data-dir` once and the folder is handed to the running instance with the wrong shell and the wrong extensions, silently. |
