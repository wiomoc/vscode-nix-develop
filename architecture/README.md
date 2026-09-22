# Architecture

| Document | What it covers |
| --- | --- |
| [classes.md](classes.md) | Every exported type and module, the relations between them, and the dependency graph |
| [startup-sequence.md](startup-sequence.md) | Opening a devShell window, end to end: picker → authority → resolver → server → teardown |

These describe the *shape* of the code. For the reasoning behind the remote-window
approach — why a server inside `nix develop` rather than patched environment variables —
see [../docs/REMOTE.md](../docs/REMOTE.md).

## The one-paragraph version

A **local window** discovers the flake's devShells (`DevShellSession`) and asks which one
to use. The answer is not stored: it is encoded into a **remote authority**
(`nix-devshell+<base32>`) and VS Code is asked to open the folder against it. In the window
that opens, the **resolver** decodes that authority back into a target, starts a VS Code
server *inside* `nix develop`, and hands back the port. Everything the remote extension
host then spawns — terminals, tasks, debuggers, language servers — is a child of a process
in the devShell, so it is in the shell for real rather than approximated.

Three things persist, and nothing else: the authority (in the window and its history), a
lock file naming the running server, and a Nix profile holding the built shell as a GC root
— that one in the project, under `.vscode/nix-devshell/`, where it outlives the servers that
use it.

## Keeping the diagrams honest

They are hand-written and will drift. The mermaid at least has to parse — the blocks in
this folder were checked with mermaid 11's own parser:

```bash
npm i mermaid jsdom            # in a scratch directory, not this repo
node -e '
  const {JSDOM} = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  global.window = dom.window; global.document = dom.window.document;
  Object.defineProperty(global, "navigator", {value: dom.window.navigator, configurable: true});
  import("mermaid").then(async ({default: m}) => {
    const fs = require("fs");
    for (const f of process.argv.slice(1)) {
      for (const [i, b] of [...fs.readFileSync(f, "utf8")
             .matchAll(/```mermaid\n([\s\S]*?)```/g)].entries()) {
        try { await m.parse(b[1]); console.log("ok  ", f, i + 1); }
        catch (e) { console.log("FAIL", f, i + 1, e.message.split("\n")[0]); }
      }
    }
  });
' architecture/*.md
```

One thing worth knowing if you edit them: **`;` ends a statement** in a mermaid sequence
diagram, so a semicolon inside a message or note is a parse error. Use a comma or a dash.
