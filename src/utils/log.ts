import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("Nix DevShell", { log: true });
  return channel;
}

function out(): vscode.LogOutputChannel {
  return initLog();
}

export const log = {
  trace: (m: string, ...a: unknown[]) => out().trace(m, ...a),
  debug: (m: string, ...a: unknown[]) => out().debug(m, ...a),
  info: (m: string, ...a: unknown[]) => out().info(m, ...a),
  warn: (m: string, ...a: unknown[]) => out().warn(m, ...a),
  error: (m: string | Error, ...a: unknown[]) => out().error(m as never, ...a),
  show: () => out().show(true),
};
