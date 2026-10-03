import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/** Writes handoff markdown into the workspace and opens it in an editor. */
export class MarkdownExporter {
  /**
   * Save `content` to `${workspaceRoot}/${outputDir}/handoff-YYYY-MM-DD-HHmm.md`.
   * Creates the folder if needed, opens the file, and returns the path.
   *
   * When no workspace folder is open we don't fail hard — we fall back to the
   * user's home directory so a handoff can always be produced.
   */
  async export(content: string): Promise<string> {
    let root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      root = os.homedir();
      void vscode.window.showWarningMessage(
        `Context Control: no workspace folder open — saving handoff to your home folder (${root}).`
      );
    }
    const cfg = vscode.workspace.getConfiguration("contextControl");
    const outputDir = cfg.get<string>("outputDir", ".ai-memory");

    const dir = path.join(root, outputDir);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `handoff-${this.stamp()}.md`);
    fs.writeFileSync(filePath, content, "utf-8");

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });

    return filePath;
  }

  /** Filename-safe local timestamp: YYYY-MM-DD-HHmm. */
  private stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(
      d.getMinutes()
    )}`;
  }
}
