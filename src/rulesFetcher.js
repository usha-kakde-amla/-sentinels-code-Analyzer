// ═══════════════════════════════════════════════════════════════
//  rulesFetcher.js
//  Fetches rules from remote server, falls back to bundled files.
//  KEY FIX: Only uses nonCompliantExample for detection — never
//  compliantExample (which contains correct/good code and was
//  causing false positives on correctly-written code).
// ═══════════════════════════════════════════════════════════════

"use strict";

const http  = require("http");
const https = require("https");
const path  = require("path");
const fs    = require("fs");

class RulesFetcher {

  async fetchAll(serverUrl, filenames, extensionPath) {
    const allRules = [];

    for (const filename of filenames) {
      const category = path.basename(filename, ".json");
      let rules = null;

      // Step 1 — try remote server
      try {
        const url  = `${serverUrl.replace(/\/$/, "")}/${filename}`;
        const json = await this._getHttp(url);
        rules = this._normalise(JSON.parse(json), category);
        console.log(`[Sentinels] ✅ Server: ${filename} (${rules.length} rules)`);
      } catch (e) {
        console.warn(`[Sentinels] ⚠️  Server failed for ${filename}: ${e.message}`);
      }

      // Step 2 — bundled fallback
      if (!rules || rules.length === 0) {
        try {
          const bundled = path.join(extensionPath, "..", "rules", filename);
          rules = this._normalise(JSON.parse(fs.readFileSync(bundled, "utf8")), category);
          console.log(`[Sentinels] 📦 Bundled: ${filename} (${rules.length} rules)`);
        } catch (e) {
          console.error(`[Sentinels] ❌ Bundled failed for ${filename}: ${e.message}`);
          rules = [];
        }
      }

      allRules.push(...rules);
    }

    return allRules;
  }

  _normalise(data, category) {
    const items = Array.isArray(data) ? data : (data.rules || []);
    return items.map(r => {
      const id       = r.RuleId || r.id || "UNKNOWN";
      const title    = r.Title  || r.name || id;
      const severity = this._mapSeverity(r.Severity || r.severity);
      const message  = r.Message || r.description || title;
      const fix      = r.Fix    || r.compliantExample || "";

      const detection = this._extractDetection(r, title);
      if (detection.length === 0) return null;

      return { id, title, category, severity, message, fix, detection, tags: r.tags || [] };
    }).filter(Boolean);
  }

  _extractDetection(r, title) {
    const patterns = [];

    // Shape A — Detection is an array (JS, TS, Security, Performance)
    if (Array.isArray(r.Detection)) {
      patterns.push(...r.Detection.filter(d => d && d.trim().length >= 3));
    }
    // Shape B — Detection is a string (SQL, Vulnerability, CSHTML)
    else if (typeof r.Detection === "string" && r.Detection.trim().length > 0) {
      patterns.push(...this._keywordsFromDesc(r.Detection));
    }

    // ✅ Only add NON-COMPLIANT example (bad code) — NEVER compliantExample
    // compliantExample is the CORRECT code and would cause false positives
    if (r.nonCompliantExample) patterns.push(r.nonCompliantExample);
    if (r.example)             patterns.push(r.example);
    // NOTE: r.compliantExample is intentionally excluded

    if (patterns.length === 0) patterns.push(title);
    return [...new Set(patterns)];
  }

  /**
   * Extracts code tokens from a natural-language detection description.
   * Only extracts tokens that represent BAD/problematic code patterns.
   */
  _keywordsFromDesc(desc) {
    const out = new Set();

    // Quoted strings (often contain specific bad values)
    for (const m of desc.matchAll(/["'`]([^"'`]{2,60})["'`]/g))
      out.add(m[1].trim());

    // Dot-notation method calls  e.g. BinaryFormatter.Deserialize
    for (const m of desc.matchAll(/\b[A-Z]\w+\.[A-Z]\w+(?:\(\))?\b/g))
      out.add(m[0]);

    // PascalCase class names  e.g. BinaryFormatter, XmlReader
    for (const m of desc.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g))
      out.add(m[0]);

    // SQL bad-pattern keywords (only the unsafe ones)
    for (const m of desc.matchAll(/\b(SELECT \*|CURSOR|EXEC(?:UTE)?\s*\(|XSS|CSRF|XXE|DTD|ViewBag|ViewData|innerHTML|eval)\b/gi))
      out.add(m[0]);

    // Razor/HTML tokens
    for (const m of desc.matchAll(/@\w+(?:\.\w+)*|<\w+>/g))
      out.add(m[0]);

    // @@ROWCOUNT and similar special SQL tokens
    for (const m of desc.matchAll(/\b(@@ROWCOUNT|EXECUTE AS)\b/gi))
      out.add(m[0]);

    // ⚠️  Do NOT add "sp_executesql" here — it is the FIX, not the problem
    return [...out].filter(t => t.length >= 3 && t !== "sp_executesql");
  }

  _mapSeverity(raw) {
    const s = (raw || "").toUpperCase();
    if (["ERROR",   "CRITICAL", "BLOCKER"].includes(s)) return "error";
    if (["INFO",    "MINOR"              ].includes(s)) return "info";
    return "warning";
  }

  _getHttp(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith("https") ? https : http;
      const req = mod.get(url, { timeout: 6000 }, res => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", c  => (body += c));
        res.on("end",  () => resolve(body));
      });
      req.on("error",   reject);
      req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout`)); });
    });
  }
}

module.exports = RulesFetcher;
