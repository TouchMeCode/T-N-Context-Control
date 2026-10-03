import * as vscode from "vscode";

/**
 * Single output channel for the extension.
 *
 * Everything that used to go to `console.warn` lands here instead: the console
 * of the extension host is invisible to users, so failures were unreportable.
 * `Context Control: Show Logs` reveals this channel.
 */
let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Context Control");
  }
  return channel;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function log(message: string): void {
  channel?.appendLine(`[${stamp()}] ${message}`);
}

/** Log a failure with its error detail, never throwing from the logger itself. */
export function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.message}` : String(err);
  channel?.appendLine(`[${stamp()}] ${message}: ${detail}`);
}

export function showLog(): void {
  channel?.show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
