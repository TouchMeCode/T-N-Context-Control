# Render the dashboard webview outside VS Code so it can be looked at.
#
# Extracts the HTML out of src/ui/dashboard.ts, stubs acquireVsCodeApi(),
# injects sample session data and VS Code's theme variables, and writes
# tools/preview/dashboard-{dark,light}.html.
#
#   python tools/make-dashboard-preview.py
#   node <browser-automation>/browser.mjs "file:///.../dashboard-dark.html" --screenshot out.png
#
# The dashboard reads its colours from --vscode-charts-* and friends, so the
# two theme blocks below are VS Code's own Dark Modern / Light Modern values.
# Keep them in sync if the dashboard starts using a token that is not listed.

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

src = io.open(os.path.join(ROOT, "src", "ui", "dashboard.ts"), encoding="utf-8").read()
start = src.index("return `<!DOCTYPE html>") + len("return `")
end = src.index("`;\n  }\n}", start)
html = src[start:end]
# The TS template literal escapes these for the enclosing backticks; undo that.
html = html.replace("\\\\25B8", "\\25B8").replace("\\\\u00a0", "\\u00a0")

SESSIONS = [
    dict(source="claude-code", project="thai-koreaTH",
         file="C:/Users/user/.claude/projects/d--thai-koreaTH/6a24ce71-9ed6-44aa-9590-051f32518e4f.jsonl",
         messages=3427, totalTokens=186420, modelLimit=200000, percentUsed=93.2,
         level="critical", estimatedCostUsd=14.82, tokenSource="usage", updatedAt=None),
    dict(source="codex", project="system-car",
         file="C:/Users/user/.codex/sessions/2026/09/08/rollout-2026-09-08T09-12-04-8f2c.jsonl",
         messages=1324, totalTokens=241900, modelLimit=272000, percentUsed=88.9,
         level="warning", estimatedCostUsd=0, tokenSource="usage", updatedAt=None,
         rateLimits=dict(primary=dict(usedPercent=81.4, windowMinutes=300, resetsAt=None),
                         secondary=dict(usedPercent=42.7, windowMinutes=10080, resetsAt=None),
                         planType="pro")),
    dict(source="claude-code", project="NBCSERV",
         file="C:/Users/user/.claude/projects/d--NBCSERV/f7f6cfdb-fcd6-4649-af15-5a899ea0ff1d.jsonl",
         messages=7660, totalTokens=709445, modelLimit=1000000, percentUsed=70.9,
         level="ok", estimatedCostUsd=38.4, tokenSource="usage", updatedAt=None),
    dict(source="claude-code", project="phoenix",
         file="C:/Users/user/.claude/projects/d--phoenix/249765f9-fd28-4f97-a595-53508bb9c8f2.jsonl",
         messages=1762, totalTokens=152300, modelLimit=200000, percentUsed=76.2,
         level="warning", estimatedCostUsd=9.15, tokenSource="usage", updatedAt=None),
    dict(source="claude-code", project="sport-store",
         file="C:/Users/user/.claude/projects/c--Users-user-Downloads-sport-store/b492d001.jsonl",
         messages=1385, totalTokens=96700, modelLimit=200000, percentUsed=48.4,
         level="ok", estimatedCostUsd=5.02, tokenSource="usage", updatedAt=None),
    dict(source="cline", project="my-web2",
         file="C:/Users/user/AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/1718/api_conversation_history.json",
         messages=412, totalTokens=61200, modelLimit=200000, percentUsed=30.6,
         level="ok", estimatedCostUsd=1.87, tokenSource="estimate", updatedAt=None),
    dict(source="claude-code", project="Toolst-n",
         file="C:/Users/user/.claude/projects/d--Toolst-n/f60d3c99.jsonl",
         messages=178, totalTokens=41000, modelLimit=1000000, percentUsed=4.1,
         level="ok", estimatedCostUsd=0.94, tokenSource="usage", updatedAt=None),
    dict(source="claude-code", project="careyou",
         file="C:/Users/user/.claude/projects/d--careyou/aa11.jsonl",
         messages=940, totalTokens=118000, modelLimit=200000, percentUsed=59.0,
         level="ok", estimatedCostUsd=3.31, tokenSource="usage", updatedAt=None),
]

PAYLOAD = {
    "type": "data",
    "sessions": SESSIONS,
    "thresholds": {"warning": 75, "critical": 90, "quotaWarning": 80, "quotaCritical": 95},
}

BOOT = """
<script>
window.acquireVsCodeApi = function(){ return { postMessage: function(){} }; };
</script>
"""

FEED = """
<script>
(function(){
  var now = Date.now();
  var p = %s;
  var offs = [3*60e3, 12*60e3, 55*60e3, 2*3600e3, 5*3600e3, 26*3600e3, 40e3, 9*3600e3];
  p.sessions.forEach(function(s,i){ s.updatedAt = now - offs[i %% offs.length]; });
  p.sessions.forEach(function(s){
    if (s.rateLimits) {
      s.rateLimits.primary.resetsAt = Math.floor(now/1000) + 2*3600 + 15*60;
      s.rateLimits.secondary.resetsAt = Math.floor(now/1000) + 3*86400;
    }
  });
  window.dispatchEvent(new MessageEvent('message', { data: p }));
}());
</script>
""" % json.dumps(PAYLOAD)

THEMES = {
    "dark": """
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818;
  --vscode-panel-border: #2b2b2b;
  --vscode-editorWidget-background: #2a2a2a;
  --vscode-editorHoverWidget-background: #202020;
  --vscode-editorHoverWidget-border: #454545;
  --vscode-editorHoverWidget-foreground: #cccccc;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-charts-green: #89d185;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-blue: #3794ff;
""",
    "light": """
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --vscode-foreground: #3b3b3b;
  --vscode-descriptionForeground: #767676;
  --vscode-editor-background: #ffffff;
  --vscode-sideBar-background: #f8f8f8;
  --vscode-panel-border: #e5e5e5;
  --vscode-editorWidget-background: #eeeeee;
  --vscode-editorHoverWidget-background: #f8f8f8;
  --vscode-editorHoverWidget-border: #c8c8c8;
  --vscode-editorHoverWidget-foreground: #3b3b3b;
  --vscode-button-background: #005fb8;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0258a8;
  --vscode-button-secondaryBackground: #e5e5e5;
  --vscode-button-secondaryForeground: #3b3b3b;
  --vscode-button-secondaryHoverBackground: #cccccc;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #3b3b3b;
  --vscode-input-border: #cecece;
  --vscode-badge-background: #cccccc;
  --vscode-badge-foreground: #3b3b3b;
  --vscode-list-activeSelectionBackground: #005fb8;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-charts-green: #388a34;
  --vscode-charts-yellow: #bf8803;
  --vscode-charts-red: #e51400;
  --vscode-charts-blue: #1a85ff;
""",
}

outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "preview")
os.makedirs(outdir, exist_ok=True)
for name, vars_ in THEMES.items():
    doc = html.replace("<script>\n(function () {", BOOT + "<script>\n(function () {", 1)
    doc = doc.replace("</head>", "<style>html{%s}</style></head>" % vars_, 1)
    doc = doc.replace("</body>", FEED + "</body>", 1)
    p = os.path.join(outdir, "dashboard-%s.html" % name)
    io.open(p, "w", encoding="utf-8", newline="\n").write(doc)
    print(p)
