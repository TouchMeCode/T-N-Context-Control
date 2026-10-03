import * as vscode from "vscode";
import type { Level, RateLimits, Source } from "../core/types";

/** Snapshot pushed to the cockpit webview on every scan. */
export interface CockpitData {
  source: Source;
  model?: string;
  percentUsed: number;
  totalTokens: number;
  modelLimit: number;
  level: Level;
  tokensPerMessage: number;
  messagesUntilCritical: number;
  estimatedCostUsd: number;
  tokenSource: "usage" | "estimate";
  rateLimits?: RateLimits;
  updatedAt: number;
}

/**
 * Sidebar "cockpit" — an always-visible WebviewView with live gauges for
 * context usage and (where the provider reports it, e.g. Codex) the rolling
 * quota limits. The page self-ticks a reset countdown so it feels live even
 * between data pushes.
 */
export class Cockpit implements vscode.WebviewViewProvider {
  public static readonly viewType = "contextControl.cockpit";
  private view: vscode.WebviewView | undefined;
  private last: CockpitData | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg?.command === "scan") {
        void vscode.commands.executeCommand("contextControl.scan");
      } else if (msg?.command === "handoff") {
        void vscode.commands.executeCommand("contextControl.handoff");
      } else if (msg?.command === "dashboard") {
        void vscode.commands.executeCommand("contextControl.dashboard");
      }
    });
    if (this.last) {
      this.post(this.last);
    }
  }

  update(data: CockpitData): void {
    this.last = data;
    this.post(data);
  }

  private post(data: CockpitData): void {
    void this.view?.webview.postMessage({ type: "data", data });
  }

  private html(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 12px; font-size: 12px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .row { display: flex; justify-content: space-between; align-items: baseline; }
  .big { font-size: 26px; font-weight: 700; line-height: 1.1; }
  .label { text-transform: uppercase; letter-spacing: .04em; font-size: 10px; }
  .bar { height: 10px; border-radius: 5px; background: var(--vscode-editorWidget-background); overflow: hidden; margin: 4px 0; }
  .bar > span { display: block; height: 100%; border-radius: 5px; width: 0; transition: width .4s ease; }
  .ok > span { background: var(--vscode-charts-green); }
  .warning > span { background: var(--vscode-charts-yellow); }
  .critical > span { background: var(--vscode-charts-red); }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
  .pill { display: inline-block; padding: 1px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; color: var(--vscode-descriptionForeground); font-size: 10px; }
  .btns { display: flex; gap: 6px; margin-top: 8px; }
  button { flex: 1; font-family: inherit; font-size: 11px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 5px; border-radius: 4px; cursor: pointer; }
  button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .small { font-size: 11px; }
  .quotaTitle { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 8px; }
</style>
</head>
<body>
  <div id="empty" class="muted">No active AI session found yet. Use Claude Code / Codex, then it appears here.</div>
  <div id="content" style="display:none">
    <div class="card">
      <div class="row"><span class="label muted">Context</span><span id="ctxSrc" class="badge"></span></div>
      <div class="row"><span id="ctxPct" class="big">--%</span><span id="ctxTok" class="muted small"></span></div>
      <div id="ctxBar" class="bar ok"><span></span></div>
      <div class="row small muted"><span id="ctxEta"></span><span id="ctxCost"></span></div>
    </div>

    <div id="quotaCard" class="card" style="display:none">
      <div class="quotaTitle"><h3>Quota</h3><span id="plan" class="pill"></span></div>
      <div id="q1">
        <div class="row small"><span id="q1name">Primary</span><span id="q1pct" class="muted"></span></div>
        <div id="q1bar" class="bar ok"><span></span></div>
        <div class="small muted" id="q1reset"></div>
      </div>
      <div id="q2" style="margin-top:8px">
        <div class="row small"><span id="q2name">Secondary</span><span id="q2pct" class="muted"></span></div>
        <div id="q2bar" class="bar ok"><span></span></div>
        <div class="small muted" id="q2reset"></div>
      </div>
    </div>

    <div id="quotaHint" class="small muted" style="display:none">Session quota is reported by Codex; Claude sessions show context only.</div>

    <div class="btns">
      <button onclick="send('scan')">Refresh</button>
      <button class="sec" onclick="send('dashboard')">Dashboard</button>
      <button class="sec" onclick="send('handoff')">Handoff</button>
    </div>
    <div class="small muted" id="updated" style="margin-top:6px"></div>
  </div>
<script>
  var vscode = acquireVsCodeApi();
  var data = null;
  function send(c){ vscode.postMessage({ command: c }); }
  function fmtTok(n){ return n >= 1000 ? (n/1000).toFixed(1)+"k" : String(n); }
  function lvl(p){ return p >= 90 ? "critical" : p >= 75 ? "warning" : "ok"; }
  function setBar(id, pct, level){
    var el = document.getElementById(id);
    el.className = "bar " + (level || lvl(pct));
    el.firstElementChild.style.width = Math.min(pct, 100) + "%";
  }
  function fmtReset(sec){
    if (sec == null) return "";
    var d = sec - Math.floor(Date.now()/1000);
    if (d <= 0) return "resets now";
    var days = Math.floor(d/86400); d -= days*86400;
    var h = Math.floor(d/3600); d -= h*3600;
    var m = Math.floor(d/60); var s = d - m*60;
    var t = days > 0 ? days+"d "+h+"h "+m+"m"
          : h > 0 ? h+"h "+m+"m "+s+"s"
          : m+"m "+s+"s";
    return "resets in " + t;
  }
  function render(){
    if (!data){ return; }
    document.getElementById("empty").style.display = "none";
    document.getElementById("content").style.display = "block";

    document.getElementById("ctxSrc").textContent = data.source + (data.model ? " · " + data.model : "");
    document.getElementById("ctxPct").textContent = data.percentUsed + "%";
    document.getElementById("ctxTok").textContent = fmtTok(data.totalTokens) + " / " + fmtTok(data.modelLimit);
    setBar("ctxBar", data.percentUsed, data.level);
    var eta = isFinite(data.messagesUntilCritical) ? "~" + data.messagesUntilCritical + " msgs left" : "";
    document.getElementById("ctxEta").textContent = eta;
    document.getElementById("ctxCost").textContent = data.tokenSource === "usage" && data.estimatedCostUsd > 0
      ? "$" + data.estimatedCostUsd.toFixed(2) : "";

    var rl = data.rateLimits;
    var qc = document.getElementById("quotaCard");
    document.getElementById("quotaHint").style.display = (rl && (rl.primary || rl.secondary)) ? "none" : "block";
    if (rl && (rl.primary || rl.secondary)){
      qc.style.display = "block";
      document.getElementById("plan").textContent = rl.planType ? titleCase(rl.planType) + " plan" : "provider quota";
      bindWindow("q1", rl.primary, "Primary");
      bindWindow("q2", rl.secondary, "Secondary");
    } else {
      qc.style.display = "none";
    }
    var ago = Math.max(0, Math.floor((Date.now() - data.updatedAt)/1000));
    document.getElementById("updated").textContent = "updated " + ago + "s ago";
  }
  function bindWindow(id, w, fallbackName){
    var box = document.getElementById(id);
    if (!w){ box.style.display = "none"; return; }
    box.style.display = "block";
    var name = quotaWindowName(w.windowMinutes);
    document.getElementById(id+"name").textContent = fallbackName + " · " + name;
    document.getElementById(id+"pct").textContent = Math.round(w.usedPercent) + "%";
    setBar(id+"bar", w.usedPercent, quotaLevel(w.usedPercent));
    box.dataset.resets = w.resetsAt == null ? "" : w.resetsAt;
  }
  function quotaLevel(pct){
    return pct >= 95 ? "critical" : pct >= 80 ? "warning" : "ok";
  }
  function quotaWindowName(minutes){
    if (minutes >= 10080 && minutes % 10080 === 0){
      var weeks = minutes / 10080;
      return weeks === 1 ? "7d weekly" : weeks + "w";
    }
    if (minutes >= 1440 && minutes % 1440 === 0){
      var days = minutes / 1440;
      return days === 1 ? "1d" : days + "d";
    }
    if (minutes >= 60 && minutes % 60 === 0){
      var hours = minutes / 60;
      return hours === 5 ? "5h session" : hours + "h";
    }
    if (minutes > 60){
      return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
    }
    return minutes + "m";
  }
  function titleCase(value){
    if (!value) return "";
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }
  function tick(){
    if (!data) return;
    ["q1","q2"].forEach(function(id){
      var box = document.getElementById(id);
      if (box.style.display === "none") return;
      var r = box.dataset.resets;
      document.getElementById(id+"reset").textContent = r ? fmtReset(parseInt(r,10)) : "";
    });
    var u = document.getElementById("updated");
    if (data) { var ago = Math.max(0, Math.floor((Date.now() - data.updatedAt)/1000)); u.textContent = "updated " + ago + "s ago"; }
  }
  window.addEventListener("message", function(ev){
    if (ev.data && ev.data.type === "data"){ data = ev.data.data; render(); tick(); }
  });
  setInterval(tick, 1000);
</script>
</body>
</html>`;
  }
}
