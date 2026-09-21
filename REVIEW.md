# Code review: defects, architecture, and cleanup plan

Review of `src/` at v0.6.3, after the removal of env mode and the shared extension directory.

Every defect below was reproduced before being written down, and the reproduction is recorded
so it can become a regression test. Findings are grouped as **defects** (the code does the
wrong thing), **architecture** (where knowledge lives, and where it has leaked), and **craft**
(Clean Code observations that are not bugs).

---

## 1. Defects


### D2 — Workspace settings are ignored when the server starts · high

```ts
const cfg = readConfig(vscode.workspace.getWorkspaceFolder(folder) ?? undefined);
```

`resolve()` runs *before* the workspace is loaded, so `getWorkspaceFolder` returns `undefined`
and only user-level settings apply.

Reproduced: a workspace with `.vscode/settings.json` containing `{"nixDevelop.impure": true}`
produced a server command with **no** `--impure`.

Silently dropped at resolve time: `impure`, `extraArgs`, `buildTimeoutSeconds`.

This is the worst shape of bug: the setting is accepted, displayed in the settings UI as
folder-scoped, and does nothing.

**Fix, preferred.** Read `<folder>/.vscode/settings.json` in the resolver — the folder path is
already in the authority. Needs a tolerant parse, since VS Code settings files legitimately
contain comments and trailing commas.

**Fix, minimum.** Re-declare those three as `machine`/`window` scope so the UI stops implying
per-folder support, and say so in the README. Being honest about the limit beats faking it.



### D5 — A generic helper reports a Nix-specific error · low

`run()` is used for `nix`, `bash`, `tar` and the server launcher, but its `ENOENT` branch says:

```ts
`Could not run '${exe}'. Is Nix installed and on PATH?`
```

A missing `tar` therefore reports that Nix is not installed.

**Fix.** Report the missing executable plainly; let the Nix-specific hint live at the call site
that knows it is calling Nix.

---

## 2. Architecture and the distribution of knowledge

The layering is sound — no cycles, and `config`/`log`/`direnv`/`authority` are leaf modules with
no internal dependencies:

```
config, log, direnv, authority   (leaves)
nix, environment, ui             -> config, log
session                          -> config, direnv, log, nix, ui
remote/{server,extensions}       -> config, log, nix
remote/resolver                  -> authority, config, extensions, log, nix, server
remote/index                     -> everything above
extension                        -> config, log, remote, session, ui
```

The problem is not the shape of the graph; it is that four pieces of domain knowledge have
escaped the module that owns them.

### K1 — "How to invoke Nix" lives in three places · high — **fixed**

`nix.ts` declares itself the owner:

```ts
const FEATURE_ARGS = ["--extra-experimental-features", "nix-command flakes"];
function baseArgs(cfg) { return [...FEATURE_ARGS, ...(cfg.impure ? ["--impure"] : [])]; }
```

but `baseArgs` is private, so `remote/server.ts` hand-rolls the same thing **twice** — once in
`start()` and again in `storePathOf()`:

```ts
"--extra-experimental-features", "nix-command flakes",
...(this.cfg.impure ? ["--impure"] : []),
```

Three copies of the rule "this is how you invoke Nix, and these flags come from config". Adding a
flag means remembering all three; `extraArgs` is already applied inconsistently between them.

**Fix.** Export `baseArgs` (or better, a `nixCommand(cfg, subcommand, args)` builder) from
`nix.ts` and route every invocation through it. `server.ts` should not know Nix's CLI surface —
it should know about *servers*.

**Fixed.** `nix.ts` exports two builders, and every Nix spawn in the extension now goes through
them:

- `nixCommand(cfg, subcommand, args, { impure? })` — the general shape. The subcommand is its
  own argument because the two flags sit on opposite sides of it, which is also how the
  ordering bug below surfaced. `impure` defaults to the setting; `storePathOf` opts out
  explicitly, since `nixpkgs#glibc` is not the user's devShell.
- `developCommand(cfg, { installable, profile, command })` — the common abstraction of
  `nix develop`. Its two callers need the same invocation but run it differently (a short-lived
  child for the capture, a detached one for the server), so it yields argv rather than running
  it. It also creates the profile's parent directory, which Nix will not.

`server.ts` no longer names a Nix flag. Unit tests pin both argv shapes.

**Found while fixing it: `nixDevelop.impure` has never worked.** `baseArgs` emitted `--impure`
*before* the subcommand, and so did both hand-rolled copies. Nix accepts it only after one:

```
$ nix --extra-experimental-features 'nix-command flakes' --impure flake show --json nixpkgs
error: unrecognised flag '--impure'
```

Turning the setting on therefore broke devShell listing, environment capture and server start
alike. D2 is why nobody hit it: the setting never reached the resolver. So the three copies had
not merely drifted apart — they agreed, and were wrong together, with nothing exercising the
one configuration that would have shown it.

### K2 — "SHELL is session-owned" is encoded twice, in two languages · medium

`environment.ts` lists `SHELL` in `SESSION_OWNED`. `server.ts` re-derives the same rule as a
bash snippet that restores the host shell. Both exist because of the same fact about `nix
develop`, but neither references the other, and only one of them still has an effect (the deny
list now only filters a *report*).

**Fix.** Name the fact once. At minimum, have the shell script's comment point at
`SESSION_OWNED` so the next reader finds both halves.

### K3 — The storage layout is spread across three modules · medium

`path.join(globalStorageUri.fsPath, "remote")` is recomputed in `resolver.ts` and twice in
`index.ts`, while sibling paths are built by `extensionsDirFor`, `lockPath`, and an inline
`profiles/<hash>` join in the resolver. No single place answers "what does this extension write
to disk, and where".

**Fix.** One `storage.ts` that, given the global storage URI and a storage key, yields
`{ serverDir, extensionsDir, serverDataDir, lockFile, profile }`. This also makes D3 a
one-liner, since the profile path becomes available where the server starts.

### K4 — Settings are declared twice with nothing checking they agree · medium — **fixed**

Every setting exists in `package.json` (name, type, default, scope) and again in `config.ts`
(`c.get<T>("name", default)`). Nothing verifies the two match. This has already bitten twice in
this project's short history: `respectDirenv` was read by `config.ts` but never declared in the
manifest, and defaults have drifted between the two and the README.

**Fix.** A test that loads `package.json` and asserts every contributed setting is read by
`readConfig` with the same default, and vice versa. Cheap, and it closes a class of bug rather
than an instance. (The README already has such a check; extend it to the manifest ↔ code pair.)

**Fixed** in `test/settings.test.ts`, as described: both directions plus the defaults. It came
along with the removal of `nixDevelop.devShell` and `nixDevelop.autoActivate`, where the same
check also guards against a half-finished removal. No pre-existing drift was found — the two
`respectDirenv`-shaped incidents the finding cites had already been resolved.

### K5 — `remote/index.ts` is a barrel *and* an implementation

Two re-export lines and eight exported functions, importing from every sibling. It is the file
everything reaches for, which makes it the natural place for things to accumulate.

**Fix.** `remote/commands.ts` for the window commands, `remote/report.ts` for the two document
renderers, leaving `index.ts` as the barrel its name promises.

---

## 3. Craft (Clean Code)

### C1 — A missing concept behind two long parameter lists

```
ServerManager.start(opts)              9 fields
resolver.installDeclaredExtensions()   8 fields
```

Overlapping: `launcher`, `installable`, `flakeDir`, `extensionsDir`, `serverDataDir`,
`extraEnv`/`patchEnv`, `progress`. That recurring clump *is* a concept — everything needed to act
on one devShell's server — and it has no name. Introducing it (`ServerContext`, built once in
`startOrAttach`) collapses both signatures to two or three arguments and removes the chance of
threading the wrong directory through.

### C2 — `startOrAttach` mixes levels of abstraction

It reads config, validates the commit, tries reuse, acquires a server, computes glibc patching,
resolves the Nix system, builds an installable, joins three paths, hashes a key, installs
extensions, starts a process, and assembles the result. The high-level story is four steps; the
path joins and hashing belong a level down (see K3).

### C3 — Flag arguments

`session.activate({ silent })` selects behaviour by flag. The two modes are "user asked for this"
and "something changed underneath" — two intentions that read better as two named entry points
than one boolean.

### C4 — Dead code

| | What | Status |
| --- | --- | --- |
| C4.1 | `authorityId` | Genuinely unused (confirmed with ripgrep after D4 masked it). Its name no longer fits either: it returns the payload, not an id. Delete. |
| C4.2 | `LockFile.installable` | Written every start, never read. Invites the assumption that the lock is validated against it. |
| C4.3 | `DirenvState.allowed` | A filesystem probe per activation, unused since the direnv deferral went with env mode. |
| C4.4 | `EnvDelta.removed` | Computed, never rendered by `renderDelta` — its only remaining consumer. |

### C5 — Comments are mostly right

The prevailing style explains *why*, not *what* — the `compgen` probe, the base32 choice, the
prune rule. That is the good kind and should stay. The exceptions are the few that compensate for
structure rather than explaining intent; those go away naturally with K3 and C1.

---

## 4. Tests

- **T1.** Neither D1 nor D2 was caught, and both are squarely in scope for the suite. Each fix
  should land with its test: a symlinked extension in a fixture directory, and a resolver-level
  assertion that a folder-scoped setting reaches the spawned command.
- **T2.** The end-to-end suites need `NIX_DEVELOP_E2E=1` plus a commit and a server directory, so
  they are easy to forget. Either wire a `test:all` that derives the commit from `code --version`,
  or state plainly in the README that they are manual.
- **T3.** K4's manifest ↔ `readConfig` check is the highest value-per-line test available here.

---

## 5. Suggested order

Each step is independent and leaves the tree green.

1. **D4** — one character. Do it first: until it is fixed, code search lies about this file.
2. **D1** — one-line filter change plus a fixture test. Fixes a prompt users actually see.
3. **D3** — add `--profile` to the server start. Small, removes a data-loss-shaped risk.
4. **C4** — delete the four dead items. Minutes.
5. **K3** — introduce `storage.ts`. This is the keystone: it makes D3 trivial, shrinks
   `startOrAttach` (C2), and is a prerequisite for C1 being worth doing.
6. **C1** — introduce `ServerContext` on top of K3.
7. **K1** — export a Nix command builder and route `server.ts` through it.
8. **K4 / T3** — the manifest consistency test.
9. **D2** — decide between reading `settings.json` and re-scoping. A design call, not a
   mechanical fix; it deserves its own discussion.
10. **K5, C3, D5** — opportunistic. Worth doing when the surrounding file is open anyway;
    splitting files nobody is touching mostly churns history.

K2 is documentation-only and can ride along with any of the above.
