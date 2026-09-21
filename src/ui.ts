import * as vscode from "vscode";
import type { DevShell } from "./nix";
import { AUTHORITY_PREFIX, decodeAuthority } from "./remote/authority";

export type Selection = { kind: "shell"; value: string } | undefined;

interface ShellItem extends vscode.QuickPickItem {
  selection: Selection;
}

/**
 * Present the devShells found in the flake. `default` is floated to the top because it is
 * what a bare `nix develop` would pick.
 *
 * `current` is the shell to mark and to seed the installable box with, when the caller
 * knows of one: the window's own shell when switching from inside a devShell, or the one
 * `.envrc` names. There is no stored selection to fall back on, so it is often absent.
 */
export async function pickDevShell(
  shells: DevShell[],
  current?: string,
): Promise<Selection> {
  const sorted = [...shells].sort((a, b) => {
    if (a.name === "default") return -1;
    if (b.name === "default") return 1;
    return a.name.localeCompare(b.name);
  });

  const items: ShellItem[] = sorted.map((s) => ({
    label: s.name === current ? `$(check) ${s.name}` : s.name,
    description:
      s.name === "default" ? "used by a bare `nix develop`" : undefined,
    detail: s.description || s.derivationName,
    selection: { kind: "shell", value: s.name },
  }));

  items.push(
    {
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
      selection: undefined,
    } as ShellItem,
    {
      label: "$(edit) Enter a flake installable…",
      detail: "e.g. .#devShells.x86_64-linux.default, or github:owner/repo#dev",
      selection: undefined,
      alwaysShow: true,
    },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: "Nix Develop: select a devShell",
    placeHolder:
      shells.length > 0
        ? "Pick the devShell to open this workspace in"
        : "No devShells found in this flake",
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;

  if (picked.label.startsWith("$(edit)")) {
    const entered = await vscode.window.showInputBox({
      title: "Nix Develop: flake installable",
      prompt: "Passed straight to `nix develop`",
      value: current || ".#devShells.",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Cannot be empty"),
    });
    return entered ? { kind: "shell", value: entered.trim() } : undefined;
  }
  return picked.selection;
}

export type StatusState =
  | { kind: "idle" }
  | { kind: "unset" }
  | { kind: "active"; label: string; summary: string }
  /** Running inside a devShell whose flake has been edited since it was built. */
  | { kind: "stale"; label: string; reason: string }
  | { kind: "error"; label: string; message: string };

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "nixDevelop.status",
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.name = "Nix Develop";
    this.set({ kind: "idle" });
  }

  set(state: StatusState): void {
    switch (state.kind) {
      case "idle":
        this.item.hide();
        return;
      case "unset":
        this.item.text = "$(package) devShell";
        this.item.tooltip = "No devShell selected — click to pick one";
        // Only a local window is ever "unset", and there picking a devShell *is* opening a
        // window in it.
        this.item.command = "nixDevelop.reopenInDevShell";
        this.item.backgroundColor = undefined;
        break;
      case "active":
        this.item.text = `$(package) ${state.label}`;
        this.item.tooltip = new vscode.MarkdownString(
          `**Nix devShell active**\n\n\`${state.label}\`\n\n${state.summary}\n\n_Click to switch devShell._`,
        );
        this.item.command = "nixDevelop.selectDevShell";
        this.item.backgroundColor = undefined;
        break;
      case "stale":
        // Warning rather than error: nothing is broken, the window is just running an
        // older shell than the flake now describes. The click is the way out of that.
        this.item.text = `$(warning) ${state.label}`;
        this.item.tooltip = new vscode.MarkdownString(
          `**Nix devShell out of date**\n\n\`${state.label}\`\n\n${state.reason}\n\n` +
            `_Click to restart the devShell server._`,
        );
        this.item.command = "nixDevelop.restartDevShell";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;
      case "error":
        this.item.text = `$(error) ${state.label}`;
        this.item.tooltip = `devShell failed: ${state.message}\nClick to view the log.`;
        this.item.command = "nixDevelop.showLog";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

export function registerResourceLabelFormatter(
  api: Partial<typeof vscode.workspace>,
): vscode.Disposable[] {
  const subscriptions: vscode.Disposable[] = [];

  if (typeof api.registerResourceLabelFormatter === "function") {
    const registerFormatter = (authority: string, devShell?: string) => {
      subscriptions.push(
        api.registerResourceLabelFormatter!({
          scheme: "vscode-remote",
          authority,
          formatting: {
            label: "${path}",
            separator: "/",
            tildify: true,
            workspaceSuffix: devShell ? `devShell: ${devShell}` : "devShell",
            workspaceTooltip: devShell
              ? `Running inside the Nix devShell '${devShell}'`
              : "Running inside a Nix devShell",
          },
        }),
      );
    };

    registerFormatter(`${AUTHORITY_PREFIX}+*`);

    // In a devShell window, name the shell in the title. Registered against the exact
    // authority so it outranks the wildcard above, which `findFormatting` resolves by
    // preferring the longest matching authority pattern.
    const authority = vscode.env.remoteAuthority;
    const target = authority ? decodeAuthority(authority) : undefined;
    if (authority && target) {
      const { devShell } = target;

      registerFormatter(
        authority,
        // Hide verbatim "default"
        devShell !== "default" ? devShell : undefined,
      );
    }
  }
  return subscriptions;
}
