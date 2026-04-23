"use strict";

const vscode             = require("vscode");
const RulesEngine        = require("./rulesEngine");
const RulesFetcher       = require("./rulesFetcher");
const DiagnosticsManager = require("./diagnosticsManager");
const GuardianPanel      = require("./guardianPanel");
const AIResolver         = require("./aiResolver");

let diagnosticsManager;
let rulesEngine;
let rulesFetcher;
let aiResolver;
let debounceTimer  = null;
let refreshTimer   = null;
let extensionPath  = "";

// Always track the last real text editor.
// When the WebView panel takes focus, activeTextEditor becomes null —
// but we never wipe this reference, so Resolve with AI always works.
let lastActiveDocument = null;

const SUPPORTED_LANGUAGES = new Set([
  "csharp", "sql", "tsql",
  "typescript", "typescriptreact",
  "javascript", "javascriptreact",
  "razor", "aspnetcorerazor", "html",
]);

async function activate(context) {
  extensionPath = context.extensionPath;

  diagnosticsManager = new DiagnosticsManager();
  rulesEngine        = new RulesEngine();
  rulesFetcher       = new RulesFetcher();
  aiResolver         = new AIResolver();

  context.subscriptions.push(diagnosticsManager.collection);

  // ── Track last active REAL text editor ─────────────────────
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && editor.document && isSupported(editor.document)) {
        // Real supported file focused — update reference
        lastActiveDocument = editor.document;
        validateDocument(editor.document);

        // Tell the panel which file is active
        if (GuardianPanel.currentPanel) {
          GuardianPanel.currentPanel.setActiveDocument(editor.document);
        }
      }
      // If editor is null (panel took focus) OR unsupported file:
      // do NOT clear lastActiveDocument — keep the last known file
    })
  );

  // ── Commands ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("sentinels.refreshRules", async () => {
      await fetchAndUpdateRules(true);
    }),

    vscode.commands.registerCommand("sentinels.validateNow", () => {
      const doc = lastActiveDocument || vscode.window.activeTextEditor?.document;
      if (doc) validateDocument(doc);
      else vscode.window.showWarningMessage("[Sentinels] No active file to validate.");
    }),

    vscode.commands.registerCommand("sentinels.showPanel", () => {
      GuardianPanel.createOrShow(
        context.extensionUri, rulesEngine, diagnosticsManager,
        aiResolver, lastActiveDocument);
    }),

    vscode.commands.registerCommand("sentinels.resolveWithAI", async () => {
      await runResolveWithAI();
    })
  );

  // ── Document change listeners ──────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!isSupported(e.document)) return;
      if (!getConfig("validateOnType")) return;
      const ms = getConfig("debounceMs") || 800;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => validateDocument(e.document), ms);
    }),
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (isSupported(doc)) validateDocument(doc);
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (isSupported(doc)) validateDocument(doc);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      diagnosticsManager.clear(doc.uri);
      if (lastActiveDocument?.uri.toString() === doc.uri.toString()) {
        lastActiveDocument = null;
      }
    })
  );

  // ── Initial load ───────────────────────────────────────────
  await fetchAndUpdateRules(false);

  // Seed lastActiveDocument from whatever is open right now
  const current = vscode.window.activeTextEditor;
  if (current && isSupported(current.document)) {
    lastActiveDocument = current.document;
  }

  vscode.window.visibleTextEditors.forEach(e => {
    if (isSupported(e.document)) validateDocument(e.document);
  });

  scheduleRefresh(context);

  // ── Status bar item ────────────────────────────────────────
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "sentinels.showPanel";
  statusItem.text    = "$(shield) Sentinels";
  statusItem.tooltip = "Open Sentinels panel";
  statusItem.show();
  context.subscriptions.push(statusItem);

  console.log("[Sentinels] Activated.");
}

// ── Resolve with AI ────────────────────────────────────────────

async function runResolveWithAI() {
  // Use lastActiveDocument (persists after panel takes focus)
  const document = lastActiveDocument || vscode.window.activeTextEditor?.document;

  if (!document) {
    vscode.window.showWarningMessage(
      "[Sentinels] Click on your source file first, then click Resolve with AI.");
    return;
  }

  if (!isSupported(document)) {
    vscode.window.showWarningMessage(
      `[Sentinels] '${document.languageId}' files are not supported.`);
    return;
  }

  // Check AI is configured
  const aiConfig = getAIConfig();
  if (!aiConfig.provider || aiConfig.provider === "none") {
    const action = await vscode.window.showWarningMessage(
      "[Sentinels] No AI provider configured. Open Settings to set one up.",
      "Open Settings");
    if (action === "Open Settings")
      vscode.commands.executeCommand("workbench.action.openSettings", "sentinels.ai");
    return;
  }

  // Get violations for this document
  const violations = diagnosticsManager.getViolations(document.uri.toString());
  if (!violations || violations.length === 0) {
    const fileName = document.fileName.split(/[\\/]/).pop();
    vscode.window.showInformationMessage(
      `[Sentinels] ✅ No violations in ${fileName} — nothing to fix!`);
    return;
  }

  const fileName     = document.fileName.split(/[\\/]/).pop();
  const providerName = aiConfig.provider[0].toUpperCase() + aiConfig.provider.slice(1);

  await vscode.window.withProgress({
    location:    vscode.ProgressLocation.Notification,
    title:       `[Sentinels] ${providerName} is fixing ${violations.length} violation(s) in ${fileName}…`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: "Sending code to AI…", increment: 20 });

      const fixedCode = await aiResolver.resolve(
        document.getText(), violations, document.languageId, aiConfig);

      progress.report({ message: "Applying fixes to file…", increment: 70 });

      // Find the editor for this document (may not be the active one)
      let targetEditor = vscode.window.visibleTextEditors
        .find(e => e.document.uri.toString() === document.uri.toString());

      if (!targetEditor) {
        targetEditor = await vscode.window.showTextDocument(
          document, vscode.ViewColumn.One);
      }

      await targetEditor.edit(editBuilder => {
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        editBuilder.replace(fullRange, fixedCode);
      });

      progress.report({ message: "Re-validating…", increment: 10 });

      validateDocument(document);
      if (GuardianPanel.currentPanel) GuardianPanel.currentPanel.refresh();

      vscode.window.showInformationMessage(
        `[Sentinels] ✅ ${providerName} fixed ${violations.length} violation(s) in ${fileName}`);

    } catch (err) {
      vscode.window.showErrorMessage(`[Sentinels] AI Error: ${err.message}`);
      console.error("[Sentinels] AI error:", err);
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────

function getConfig(key) {
  return vscode.workspace.getConfiguration("sentinels").get(key);
}

function getAIConfig() {
  const c = vscode.workspace.getConfiguration("sentinels.ai");
  return {
    provider:     c.get("provider")     || "gemini",
    groqApiKey:   c.get("groqApiKey")   || "",
    groqModel:    c.get("groqModel")    || "llama3-70b-8192",
    openaiApiKey: c.get("openaiApiKey") || "",
    openaiModel:  c.get("openaiModel")  || "gpt-4o",
    geminiApiKey: c.get("geminiApiKey") || "",
    geminiModel:  c.get("geminiModel")  || "gemini-2.5-flash",
    ollamaUrl:    c.get("ollamaUrl")    || "http://localhost:11434",
    ollamaModel:  c.get("ollamaModel")  || "llama3",
  };
}

function isSupported(document) {
  if (!document || document.uri.scheme !== "file") return false;
  return SUPPORTED_LANGUAGES.has(document.languageId);
}

async function fetchAndUpdateRules(showNotification) {
  const serverUrl = getConfig("serverUrl") || "http://172.30.104.55";
  const ruleFiles = getConfig("ruleFiles") || [
    "Security.json","Vulnerability.json","Performance.json",
    "SQL.json","Typescript.json","Javascript.json","CSHTML.json"
  ];

  if (showNotification)
    vscode.window.showInformationMessage("[Sentinels] Fetching latest rules…");

  try {
    const allRules = await rulesFetcher.fetchAll(
      serverUrl, ruleFiles, extensionPath + "/src");
    rulesEngine.setRules(allRules);

    const total = rulesEngine.ruleCount();
    const cats  = [...new Set(allRules.map(r => r.category))].join(", ");
    const msg   = `[Sentinels] Loaded ${total} rules (${cats})`;

    if (showNotification) vscode.window.showInformationMessage(msg);
    else                   console.log(msg);

    vscode.window.visibleTextEditors.forEach(e => {
      if (isSupported(e.document)) validateDocument(e.document);
    });
  } catch (err) {
    const msg = `[Sentinels] Failed to load rules: ${err.message}`;
    if (showNotification) vscode.window.showErrorMessage(msg);
    else                   console.error(msg);
  }
}

function scheduleRefresh(context) {
  if (refreshTimer) clearInterval(refreshTimer);
  const ms = (getConfig("refreshIntervalMinutes") || 30) * 60 * 1000;
  refreshTimer = setInterval(() => fetchAndUpdateRules(false), ms);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
}

function validateDocument(document) {
  if (!document || document.uri.scheme !== "file") return;
  if (!isSupported(document)) return;
  const violations = rulesEngine.validate(document.getText(), document.languageId);
  diagnosticsManager.update(document.uri, violations, document);
  if (GuardianPanel.currentPanel) GuardianPanel.currentPanel.refresh();
}

function deactivate() {
  if (refreshTimer)  clearInterval(refreshTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
}

module.exports = { activate, deactivate };
