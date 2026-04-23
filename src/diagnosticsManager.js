// ═══════════════════════════════════════════════════════════════
//  diagnosticsManager.js
//  Converts RulesEngine violations → VS Code squiggles
// ═══════════════════════════════════════════════════════════════

"use strict";

const vscode = require("vscode");

class DiagnosticsManager {
  constructor() {
    this.collection   = vscode.languages.createDiagnosticCollection("sentinels");
    this._violations  = new Map(); // uri.toString() → Violation[]
  }

  update(uri, violations, document) {
    this._violations.set(uri.toString(), violations);

    const diagnostics = violations.map(v => {
      const line   = Math.min(v.line, document.lineCount - 1);
      const text   = document.lineAt(line).text;
      const colEnd = Math.min(v.colEnd, text.length);
      const range  = new vscode.Range(line, v.colStart, line, colEnd);

      const diag = new vscode.Diagnostic(
        range,
        `[${v.ruleId}] ${v.message}`,
        this._toVsCodeSeverity(v.severity)
      );
      diag.source = `Sentinels (${v.category})`;
      diag.code   = v.ruleId;

      if (v.fix) {
        diag.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(uri, range),
            `💡 Fix: ${v.fix}`
          )
        ];
      }
      return diag;
    });

    this.collection.set(uri, diagnostics);
  }

  getViolations(uriString)  { return this._violations.get(uriString) || []; }

  getAllViolations() {
    const all = [];
    for (const [uri, violations] of this._violations)
      all.push(...violations.map(v => ({ ...v, _uri: uri })));
    return all;
  }

  clear(uri) {
    this._violations.delete(uri.toString());
    this.collection.delete(uri);
  }

  _toVsCodeSeverity(sev) {
    switch (sev) {
      case "error":   return vscode.DiagnosticSeverity.Error;
      case "info":    return vscode.DiagnosticSeverity.Information;
      default:        return vscode.DiagnosticSeverity.Warning;
    }
  }

  dispose() { this.collection.dispose(); }
}

module.exports = DiagnosticsManager;
