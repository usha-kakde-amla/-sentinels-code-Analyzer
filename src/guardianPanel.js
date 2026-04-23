"use strict";

const vscode = require("vscode");

const CAT_ICONS = {
  Security:"🔒", Vulnerability:"⚠️", Performance:"⚡",
  SQL:"🗄️", Typescript:"🔷", Javascript:"🟨", CSHTML:"🌐",
};

const LANG_LABELS = {
  csharp:"C# (.cs)", sql:"SQL (.sql)", tsql:"T-SQL (.sql)",
  typescript:"TypeScript (.ts)", typescriptreact:"TypeScript React (.tsx)",
  javascript:"JavaScript (.js)", javascriptreact:"JavaScript React (.jsx)",
  razor:"Razor (.cshtml)", aspnetcorerazor:"Razor (.cshtml)", html:"CSHTML",
};

const PROVIDER_INFO = {
  groq:   { label:"Groq",   icon:"⚡", color:"#f55036" },
  openai: { label:"OpenAI", icon:"🤖", color:"#10a37f" },
  gemini: { label:"Gemini", icon:"✨", color:"#4285f4" },
  ollama: { label:"Ollama", icon:"🦙", color:"#ff6b35" },
};

class GuardianPanel {
  static currentPanel = undefined;

  static createOrShow(extensionUri, rulesEngine, diagnosticsManager, aiResolver, activeDocument) {
    const column = vscode.ViewColumn.Beside;
    if (GuardianPanel.currentPanel) {
      GuardianPanel.currentPanel._panel.reveal(column);
      // Update active document when panel is re-opened
      if (activeDocument) {
        GuardianPanel.currentPanel.setActiveDocument(activeDocument);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "sentinels", "⚔️ Sentinels", column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    GuardianPanel.currentPanel = new GuardianPanel(
      panel, rulesEngine, diagnosticsManager, aiResolver, activeDocument);
  }

  constructor(panel, rulesEngine, diagnosticsManager, aiResolver, activeDocument) {
    this._panel              = panel;
    this._rulesEngine        = rulesEngine;
    this._diagnosticsManager = diagnosticsManager;
    this._aiResolver         = aiResolver;
    this._disposables        = [];

    // Own reference — NEVER cleared when WebView takes focus
    this._activeDocument = activeDocument || null;

    this._update();

    panel.onDidDispose(() => this.dispose(), null, this._disposables);
    panel.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg), null, this._disposables);

    // Re-render when settings change
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("sentinels") && this._panel.visible)
        this._update();
    }, null, this._disposables);
  }

  // Called by extension.js whenever a real text editor becomes active
  setActiveDocument(document) {
    this._activeDocument = document;
    if (this._panel.visible) this._update();
  }

  refresh() {
    if (this._panel.visible) this._update();
  }

  _getAIConfig() {
    const c = vscode.workspace.getConfiguration("sentinels.ai");
    return {
      provider:    c.get("provider")    || "gemini",
      groqModel:   c.get("groqModel")   || "llama3-70b-8192",
      openaiModel: c.get("openaiModel") || "gpt-4o",
      geminiModel: c.get("geminiModel") || "gemini-2.5-flash",
      ollamaModel: c.get("ollamaModel") || "llama3",
    };
  }

  _update() {
    const doc        = this._activeDocument;
    const languageId = doc?.languageId || "";
    const fileName   = doc ? doc.fileName.split(/[\\/]/).pop() : null;

    // Get violations only for the tracked document
    let violations = [];
    if (doc) {
      violations = this._diagnosticsManager.getViolations(doc.uri.toString());
    }

    const aiConfig = this._getAIConfig();
    this._panel.webview.html = this._buildHtml(
      violations, languageId, fileName, aiConfig);
  }

  _handleMessage(message) {
    switch (message.command) {
      case "navigateTo": {
        const { uri, line, col } = message;
        vscode.workspace.openTextDocument(vscode.Uri.parse(uri)).then(doc =>
          vscode.window.showTextDocument(doc, vscode.ViewColumn.One).then(editor => {
            const pos = new vscode.Position(line, col);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(
              new vscode.Range(pos, pos),
              vscode.TextEditorRevealType.InCenter);
          })
        );
        break;
      }
      case "refreshRules":
        vscode.commands.executeCommand("sentinels.refreshRules"); break;
      case "validateNow":
        vscode.commands.executeCommand("sentinels.validateNow"); break;
      case "resolveWithAI":
        vscode.commands.executeCommand("sentinels.resolveWithAI"); break;
      case "openAISettings":
        vscode.commands.executeCommand(
          "workbench.action.openSettings", "sentinels.ai"); break;
    }
  }

  _buildHtml(violations, languageId, fileName, aiConfig) {
    const totalRules  = this._rulesEngine.ruleCount();
    const errorCount  = violations.filter(v => v.severity === "error").length;
    const warnCount   = violations.filter(v => v.severity === "warning").length;
    const infoCount   = violations.filter(v => v.severity === "info").length;

    const langLabel   = LANG_LABELS[languageId] || (languageId || "—");
    const allowedCats = this._rulesEngine.getCategoriesForLanguage(languageId);

    const provider  = aiConfig.provider || "none";
    const provInfo  = PROVIDER_INFO[provider];
    const modelName = provider === "groq"   ? aiConfig.groqModel
                    : provider === "openai" ? aiConfig.openaiModel
                    : provider === "gemini" ? aiConfig.geminiModel
                    : provider === "ollama" ? aiConfig.ollamaModel : null;

    // AI badge
    const aiBadgeHtml = provInfo
      ? `<span class="ai-badge" style="border-color:${provInfo.color};color:${provInfo.color}">
           ${provInfo.icon} ${provInfo.label} · ${modelName}
         </span>`
      : `<span class="ai-badge ai-none" onclick="msg('openAISettings')">
           🤖 No AI configured — click to setup
         </span>`;

    // Resolve button state
    const canResolve   = !!provInfo && violations.length > 0;
    const resolveTitle = !provInfo
      ? "Configure an AI provider in Settings first"
      : violations.length === 0
        ? "No violations to fix"
        : `Fix ${violations.length} violation(s) using ${provInfo.label}`;

    // Active file display
    const activeFileHtml = fileName
      ? `<strong>${esc(fileName)}</strong>
         <span style="opacity:.5;font-size:11px">(${esc(langLabel)})</span>`
      : `<span style="opacity:.5">— click on a source file —</span>`;

    const activeCatsHtml = allowedCats.length > 0
      ? allowedCats.map(c => `<span class="active-cat">${CAT_ICONS[c]||""} ${c}</span>`).join("")
      : `<span class="active-cat" style="opacity:.4">—</span>`;

    // Group violations by category
    const byCategory = {};
    for (const v of violations) {
      if (!byCategory[v.category]) byCategory[v.category] = [];
      byCategory[v.category].push(v);
    }

    const categoryHtml = Object.entries(byCategory).map(([cat, items]) => {
      const icon = CAT_ICONS[cat] || "📋";
      const itemsHtml = items.map(v => {
        const sev     = v.severity;
        const dot     = sev === "error" ? "🔴" : sev === "warning" ? "🟡" : "🔵";
        const navData = v._uri
          ? `data-uri="${esc(v._uri)}" data-line="${v.line}" data-col="${v.colStart}"`
          : "";
        const tagsHtml = (v.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("");
        return `
          <div class="violation ${sev}" ${navData} onclick="navigateTo(this)">
            <div class="v-header">
              <span>${dot}</span>
              <span class="v-id">${esc(v.ruleId)}</span>
              <span class="v-title">${esc(v.title)}</span>
              <span class="v-sev ${sev}">${sev.toUpperCase()}</span>
            </div>
            <div class="v-body">
              <p class="v-msg">⚠️ ${esc(v.message)}</p>
              ${v.fix?`<p class="v-fix">💡 <strong>Fix:</strong> ${esc(v.fix)}</p>`:""}
              ${v.matchedText?`<code class="v-match">${esc(v.matchedText)}</code>`:""}
              ${tagsHtml?`<div class="v-tags">${tagsHtml}</div>`:""}
              ${v._uri?`<span class="v-loc">Line ${v.line+1}, Col ${v.colStart+1}</span>`:""}
            </div>
          </div>`;
      }).join("");
      return `
        <details open>
          <summary class="cat-header">
            <span>${icon} ${esc(cat)}</span>
            <span class="cat-count">${items.length}</span>
          </summary>
          <div class="cat-body">${itemsHtml}</div>
        </details>`;
    }).join("");

    const allClearHtml = violations.length === 0 && fileName
      ? `<div class="all-clear"><div>✅</div><h2>All Clear!</h2><p>No violations. Great job! 🎉</p></div>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinels</title>
<style>
  :root {
    --bg:   var(--vscode-editor-background);
    --fg:   var(--vscode-editor-foreground);
    --bdr:  var(--vscode-panel-border);
    --hov:  var(--vscode-list-hoverBackground);
    --card: var(--vscode-editorWidget-background);
    --code: var(--vscode-textCodeBlock-background);
    --err:  #f97583; --warn:#e3b341; --info:#79b8ff;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--fg);background:var(--bg);padding:12px}

  .toolbar{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
  .toolbar h1{font-size:1.1em;flex:1}

  .btn{border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;font-weight:600;
       display:flex;align-items:center;gap:4px;white-space:nowrap;transition:opacity .15s,transform .1s}
  .btn:hover:not(:disabled){opacity:.85;transform:translateY(-1px)}
  .btn:disabled{opacity:.35;cursor:not-allowed}

  .btn-gray{background:var(--vscode-button-secondaryBackground,#3c3c3c);color:var(--vscode-button-secondaryForeground,#ccc)}
  .btn-blue{background:#2563eb;color:#fff}
  .btn-blue:hover:not(:disabled){background:#1d4ed8}

  .btn-ai{
    background:linear-gradient(135deg,#7c3aed,#a855f7);
    color:#fff;
    box-shadow:0 0 10px rgba(168,85,247,.4);
    border:1px solid rgba(168,85,247,.5);
    position:relative;overflow:hidden;
  }
  .btn-ai:hover:not(:disabled){background:linear-gradient(135deg,#6d28d9,#9333ea);box-shadow:0 0 18px rgba(168,85,247,.6)}
  .btn-ai:disabled{background:#374151;box-shadow:none;border-color:transparent}
  .btn-ai::after{content:'';position:absolute;top:0;left:-100%;width:60%;height:100%;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent);
    animation:shimmer 2.5s infinite}
  @keyframes shimmer{0%{left:-100%}100%{left:200%}}

  .ai-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;font-size:12px}
  .ai-badge{font-size:11px;font-weight:700;border:1px solid;border-radius:12px;padding:2px 10px}
  .ai-none{border-color:#6b7280;color:#6b7280;cursor:pointer;text-decoration:underline dotted}
  .btn-cfg{background:transparent;border:1px solid var(--bdr);border-radius:4px;
           color:var(--fg);font-size:10px;padding:2px 8px;cursor:pointer;opacity:.7}
  .btn-cfg:hover{opacity:1}

  hr{border:none;border-top:1px solid var(--bdr);margin:8px 0}

  .file-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:12px;flex-wrap:wrap}
  .cats-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px;flex-wrap:wrap}
  .active-cat{background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:1px 7px}

  .stats{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .pill{display:flex;align-items:center;gap:4px;background:var(--card);border:1px solid var(--bdr);
        border-radius:12px;padding:3px 10px;font-size:12px;font-weight:600}
  .pill.err{border-color:var(--err);color:var(--err)}
  .pill.warn{border-color:var(--warn);color:var(--warn)}
  .pill.info{border-color:var(--info);color:var(--info)}

  .rules-note{font-size:10px;opacity:.4;margin-bottom:6px}

  details{margin-bottom:7px}
  summary.cat-header{display:flex;justify-content:space-between;align-items:center;cursor:pointer;
    padding:6px 10px;background:var(--card);border:1px solid var(--bdr);border-radius:4px;
    font-weight:700;font-size:13px;user-select:none;list-style:none}
  summary.cat-header::-webkit-details-marker{display:none}
  summary.cat-header:hover{background:var(--hov)}
  .cat-count{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
             border-radius:10px;padding:1px 8px;font-size:11px}

  .violation{background:var(--card);border-left:3px solid var(--bdr);border-radius:0 4px 4px 0;
             margin:3px 0;padding:7px 10px;cursor:pointer}
  .violation:hover{background:var(--hov)}
  .violation.error{border-left-color:var(--err)}
  .violation.warning{border-left-color:var(--warn)}
  .violation.info{border-left-color:var(--info)}
  .v-header{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
  .v-id{font-weight:700;font-size:11px;opacity:.65}
  .v-title{font-weight:600;flex:1}
  .v-sev{font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px}
  .v-sev.error{background:var(--err);color:#000}
  .v-sev.warning{background:var(--warn);color:#000}
  .v-sev.info{background:var(--info);color:#000}
  .v-body{font-size:12px}
  .v-msg{margin:2px 0}
  .v-fix{margin:2px 0;color:#73d397}
  .v-match{display:block;background:var(--code);border-radius:3px;padding:2px 6px;margin:4px 0;
           font-family:var(--vscode-editor-font-family);font-size:11px;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .v-tags{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px}
  .tag{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
       border-radius:3px;padding:1px 5px;font-size:10px}
  .v-loc{font-size:10px;opacity:.55;display:block;margin-top:2px}

  .all-clear{text-align:center;padding:40px 20px;opacity:.7}
  .all-clear div{font-size:44px}
  .all-clear h2{margin:8px 0 5px}
</style>
</head>
<body>

<!-- Toolbar -->
<div class="toolbar">
  <h1>⚔️ Sentinels</h1>
  <button class="btn btn-gray" onclick="msg('refreshRules')">🔄 Refresh</button>
  <button class="btn btn-blue" onclick="msg('validateNow')">▶ Validate Now</button>
  <button class="btn btn-ai" onclick="msg('resolveWithAI')"
    ${canResolve ? "" : "disabled"} title="${esc(resolveTitle)}">
    🤖 Resolve with AI
  </button>
</div>

<!-- AI row -->
<div class="ai-row">
  <span style="opacity:.6">AI:</span>
  ${aiBadgeHtml}
  <button class="btn-cfg" onclick="msg('openAISettings')">⚙ Configure AI</button>
</div>

<hr>

<p class="rules-note">📋 ${totalRules} rules loaded</p>

<!-- Active file -->
<div class="file-row">
  <span style="opacity:.6;font-size:11px">File:</span>
  ${activeFileHtml}
</div>
<div class="cats-row">
  <span style="opacity:.6">Rules:</span>
  ${activeCatsHtml}
</div>

<!-- Stats -->
<div class="stats">
  <div class="pill err">🔴 ${errorCount} Errors</div>
  <div class="pill warn">🟡 ${warnCount} Warnings</div>
  <div class="pill info">🔵 ${infoCount} Info</div>
  <div class="pill">Total: ${violations.length}</div>
</div>

${allClearHtml}
${categoryHtml}

<script>
  const vscode = acquireVsCodeApi();
  function msg(command) { vscode.postMessage({ command }); }
  function navigateTo(el) {
    const uri  = el.getAttribute('data-uri');
    const line = parseInt(el.getAttribute('data-line'), 10);
    const col  = parseInt(el.getAttribute('data-col'),  10);
    if (uri && !isNaN(line)) vscode.postMessage({ command:'navigateTo', uri, line, col });
  }
</script>
</body>
</html>`;
  }

  dispose() {
    GuardianPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) this._disposables.pop()?.dispose();
  }
}

function esc(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

module.exports = GuardianPanel;
