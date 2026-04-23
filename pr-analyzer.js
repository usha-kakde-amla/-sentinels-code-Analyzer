#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  pr-analyzer.js  — Sentinels PR Analyzer
//
//  Uses the SAME RulesEngine + RulesFetcher as the VS Code
//  extension so PR results match exactly what you see in the
//  editor panel (same rule IDs, severities, messages, fixes).
//
//  Gemini 2.5 Flash is used ONLY to:
//    • Confirm / filter matches (removes false positives)
//    • Add a one-line explanation per violation
//    • Generate an actionable fix suggestion
//
//  Usage (Windows CMD):
//    set GEMINI_API_KEY=AIzaSy...
//    node pr-analyzer.js --file src\app.js
//    node pr-analyzer.js --diff PR123.diff --output report.json
//
//  Usage (PowerShell):
//    $env:GEMINI_API_KEY="AIzaSy..."
//    node pr-analyzer.js --file src\app.js
//
//  Options:
//    --file   <path>   Analyze a single source file
//    --diff   <path>   Analyze a unified diff (e.g. from git diff)
//    --output <path>   Save full JSON report to a file
//    --lang   <id>     Force language (javascript/typescript/csharp/sql/html)
//    --no-gemini       Run rules-only mode (no Gemini API needed)
// ═══════════════════════════════════════════════════════════════

"use strict";

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ── Config ──────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview-04-17";
const RULES_DIR      = process.env.RULES_DIR    || path.join(__dirname, "rules");

// ── Extension → Language ID ─────────────────────────────────────
const EXT_LANG_MAP = {
  ".js":    "javascript",
  ".jsx":   "javascriptreact",
  ".ts":    "typescript",
  ".tsx":   "typescriptreact",
  ".cs":    "csharp",
  ".sql":   "sql",
  ".cshtml":"razor",
  ".html":  "html",
};

// ── Language → Rule files (mirrors rulesEngine.js) ──────────────
const LANGUAGE_CATEGORY_MAP = {
  "csharp":          ["Security", "Vulnerability", "Performance"],
  "sql":             ["SQL"],
  "tsql":            ["SQL"],
  "typescript":      ["Typescript"],
  "typescriptreact": ["Typescript"],
  "javascript":      ["Javascript"],
  "javascriptreact": ["Javascript"],
  "razor":           ["CSHTML"],
  "aspnetcorerazor": ["CSHTML"],
  "html":            ["CSHTML"],
};

const CATEGORY_FILE_MAP = {
  "Security":    "Security.json",
  "Vulnerability":"Vulnerability.json",
  "Performance": "Performance.json",
  "SQL":         "SQL.json",
  "Typescript":  "Typescript.json",
  "Javascript":  "Javascript.json",
  "CSHTML":      "CSHTML.json",
};

// ── Same DETECTION_OVERRIDES as rulesEngine.js ──────────────────
const DETECTION_OVERRIDES = {
  "TSQL001": ["SELECT *", "SELECT*"],
  "TSQL004": ["INSERT INTO", "UPDATE ", "DELETE FROM", "MERGE INTO"],
  "TSQL005": ["UPDATE ", "DELETE FROM", "INSERT INTO"],
  "TSQL006": ["EXEC('", 'EXEC("', "' + @", "@ + '", "+ N'", "N' +", "SET @sql"],
  "TSQL007": ["EXEC(@", "EXEC (@", "EXECUTE(@", "EXECUTE (@"],
  "TSQL008": ["YEAR(", "MONTH(", "DAY(", "CONVERT(CHAR", "UPPER(", "LOWER(", "ISNULL("],
  "TSQL009": ["CURSOR FOR", "FETCH NEXT", "OPEN cursor", "DECLARE CURSOR"],
  "TSQL010": ["EXECUTE AS LOGIN", "EXECUTE AS USER", "EXECUTE AS OWNER"],
  "TSQL011": ["CreditCardNumber", "SocialSecurityNumber", "SSN", "CVV", "AccountPassword"],
  "SEC001":  ["password =", "Password =", "apiKey =", "APIKey =", "secret =", "Secret =", "connectionString ="],
  "SEC002":  ["+ userId", "+ id ", "+ input", "+ userInput", '" + "', "' + '"],
  "SEC007":  ["new MD5", "MD5.Create", "new SHA1", "SHA1.Create", "new DES", "DESCryptoServiceProvider"],
  "SEC008":  ["log(password", "log(Password", "log(token", "log(Token", "Write(password"],
  "SEC012":  ["new Random()", "new System.Random()"],
  "SEC025":  ["AllowAnyOrigin()", ".AllowAnyOrigin"],
  "VUL001":  ["+ userId", "+ id ", "+ username", '+ "SELECT', "+ @name", 'ExecuteNonQuery("SELECT'],
  "VUL002":  ['= "password"', '= "Password"', '= "secret"', '= "apikey"', 'apiKey = "'],
  "VUL003":  ["new MD5CryptoServiceProvider", "new SHA1CryptoServiceProvider", "new DESCryptoServiceProvider"],
  "VUL004":  ["File.ReadAllText(userInput", "File.ReadAllText(input", "Path.Combine(userInput", "+ userInput"],
  "VUL005":  ["BinaryFormatter", ".Deserialize(stream", ".Deserialize(input"],
  "VUL006":  ["db.Users.Remove", "db.Delete", "repository.Delete"],
  "VUL009":  ["http://api.", "http://www.", 'GetAsync("http:', 'PostAsync("http:'],
  "VUL011":  ['Response.Write("<', "innerHTML =", ".innerHTML ="],
  "VUL012":  ["new Random()", "rng.Next()", "new System.Random"],
  "PERF101": ["executeQuery(", "ExecuteQuery(", "ExecuteNonQuery(", "db.Query(", ".Find(", ".FirstOrDefault("],
  "PERF105": ["getUserData(userId)", "getUser(id)", "fetchData(id)"],
  "PERF107": ["JSON.parse(", "JsonSerializer.Deserialize(", "XmlSerializer"],
  "PERF108": [".Count()", ".count()"],
  "JS_SEC002":  ["eval(", "new Function("],
  "JS_SEC003":  ["innerHTML =", "dangerouslySetInnerHTML"],
  "JS_SEC005":  ["child_process.exec(", "exec(cmd", "spawn(cmd"],
  "JS_PERF001": ["while(true)", "for(;;)"],
  "JS_PERF004": ["console.log(", "console.debug("],
  "TS_SEC003":  ["as unknown as"],
  "TS_PERF003": ["JSON.parse(JSON.stringify("],
  "CSHTML004":  ["@Html.Raw(", "Html.Raw("],
  "CSHTML005":  ["@ViewBag.", "@ViewData["],
  "CSHTML007":  ['<form method="post"', "<form method='post'"],
};

// ── Same exclusions as rulesEngine.js ───────────────────────────
const RULE_EXCLUSIONS = {
  "TSQL006": { lineExclusions: ["sp_executesql", "sp_executeSql"], fileExclusions: ["sp_executesql"] },
  "TSQL007": { lineExclusions: ["sp_executesql", "sp_executeSql"], fileExclusions: [] },
  "TSQL004": { lineExclusions: ["TRY", "BEGIN TRY"], fileExclusions: ["BEGIN TRY"] },
  "TSQL005": { lineExclusions: ["@@ROWCOUNT"], fileExclusions: ["@@ROWCOUNT"] },
  "TSQL001": { lineExclusions: [], fileExclusions: [] },
  "TSQL008": { lineExclusions: ["DECLARE", "NVARCHAR", "VARCHAR", "CHAR(", "PARAMETER"], fileExclusions: [] },
  "TSQL009": { lineExclusions: ["DECLARE @"], fileExclusions: [] },
  "VUL009":  { lineExclusions: ["https://"], fileExclusions: [] },
  "SEC011":  { lineExclusions: ["https", "UseHttpsRedirection"], fileExclusions: ["UseHttpsRedirection"] },
  "JS_PERF004": { lineExclusions: ["logger", "Logger", "winston", "pino", "//"], fileExclusions: [] },
  "PERF101": { lineExclusions: [], fileExclusions: [] },
};

const STOP_WORDS = new Set([
  "with","from","that","this","have","been","will","used","into","when",
  "over","also","only","then","them","they","each","such","some","both",
  "like","call","able","the","and","for","are","was","not","all","any",
  "but","more","than","new","var","int","let","use","get","set","its",
  "string","object","using","void","return","public","private","class",
  "static","async","await","null","true","false","bool","list","type",
  "can","may","must","allow","should","never","avoid","without","before",
  "after","inside","detect","check","ensure","missing","usage","prevent",
]);

// ═══════════════════════════════════════════════════════════════
//  STEP 1: Load rules from /rules folder
// ═══════════════════════════════════════════════════════════════
function loadRulesForLanguage(languageId) {
  const categories = LANGUAGE_CATEGORY_MAP[languageId] || [];
  const allRules   = [];

  for (const cat of categories) {
    const filename = CATEGORY_FILE_MAP[cat];
    if (!filename) continue;

    const ruleFile = path.join(RULES_DIR, filename);
    if (!fs.existsSync(ruleFile)) {
      console.warn(`  ⚠️  Rule file not found: ${ruleFile}`);
      continue;
    }
    try {
      const raw   = JSON.parse(fs.readFileSync(ruleFile, "utf8"));
      const items = Array.isArray(raw) ? raw : (raw.rules || []);

      // Normalise to internal format (same as rulesFetcher._normalise)
      for (const r of items) {
        const id       = r.RuleId   || r.id       || "UNKNOWN";
        const title    = r.Title    || r.name      || id;
        const severity = mapSeverity(r.Severity   || r.severity);
        const message  = r.Message  || r.description || title;
        const fix      = r.Fix      || r.compliantExample || "";
        const detection= extractDetection(r, title);
        if (detection.length === 0) continue;
        allRules.push({ id, title, category: cat, severity, message, fix, detection });
      }
      console.log(`  ✅ Loaded ${items.length} rules from ${filename} [${cat}]`);
    } catch (e) {
      console.error(`  ❌ Failed to parse ${filename}: ${e.message}`);
    }
  }
  return allRules;
}

function mapSeverity(raw) {
  const s = (raw || "").toUpperCase();
  if (["ERROR","CRITICAL","BLOCKER"].includes(s)) return "error";
  if (["INFO","MINOR"].includes(s))                return "info";
  return "warning";
}

function extractDetection(r, title) {
  const patterns = [];
  if (Array.isArray(r.Detection))          patterns.push(...r.Detection.filter(d => d?.trim().length >= 3));
  else if (typeof r.Detection === "string" && r.Detection.trim()) patterns.push(...keywordsFromDesc(r.Detection));
  if (r.nonCompliantExample) patterns.push(r.nonCompliantExample);
  if (r.example)             patterns.push(r.example);
  if (patterns.length === 0) patterns.push(title);
  return [...new Set(patterns)];
}

function keywordsFromDesc(desc) {
  const out = new Set();
  for (const m of desc.matchAll(/["'`]([^"'`]{2,60})["'`]/g)) out.add(m[1].trim());
  for (const m of desc.matchAll(/\b[A-Z]\w+\.[A-Z]\w+(?:\(\))?\b/g)) out.add(m[0]);
  for (const m of desc.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g)) out.add(m[0]);
  for (const m of desc.matchAll(/\b(SELECT \*|CURSOR|EXEC(?:UTE)?\s*\(|XSS|CSRF|XXE|DTD|ViewBag|ViewData|innerHTML|eval)\b/gi)) out.add(m[0]);
  for (const m of desc.matchAll(/@\w+(?:\.\w+)*|<\w+>/g)) out.add(m[0]);
  for (const m of desc.matchAll(/\b(@@ROWCOUNT|EXECUTE AS)\b/gi)) out.add(m[0]);
  return [...out].filter(t => t.length >= 3 && t !== "sp_executesql");
}

function tokenise(pattern) {
  const cleaned = pattern.replace(/['";`,(){}[\]\r\n]/g, " ").replace(/\s+/g, " ").trim();
  const tokens  = cleaned.split(" ")
    .filter(t => t.length >= 4 && !STOP_WORDS.has(t.toLowerCase()))
    .filter((t, i, a) => a.indexOf(t) === i)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
  if (tokens.length >= 2) tokens.unshift(`${tokens[0]} ${tokens[1]}`);
  return tokens;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2: Run the same pattern-matching as RulesEngine.validate()
// ═══════════════════════════════════════════════════════════════
function runRulesEngine(text, languageId, rules) {
  if (!text || rules.length === 0) return [];

  const lines      = text.split("\n");
  const textLower  = text.toLowerCase();
  const violations = [];
  const seen       = new Set();

  for (const rule of rules) {
    // File-level exclusion
    const excl = RULE_EXCLUSIONS[rule.id];
    if (excl?.fileExclusions?.length > 0) {
      if (excl.fileExclusions.some(p => textLower.includes(p.toLowerCase()))) continue;
    }

    const overrides = DETECTION_OVERRIDES[rule.id];
    const matches   = overrides
      ? literalMatch(lines, overrides, rule.id)
      : keywordMatch(lines, rule.detection, rule.id);

    for (const m of matches) {
      const key = `${rule.id}::${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({
        ruleId:      rule.id,
        title:       rule.title,
        category:    rule.category,
        severity:    rule.severity,
        message:     rule.message,
        fix:         rule.fix,
        line:        m.line + 1,   // convert to 1-based
        colStart:    m.colStart,
        colEnd:      m.colEnd,
        matchedText: m.matchedText,
      });
    }
  }

  return violations.sort((a, b) => {
    const o = { error: 0, warning: 1, info: 2 };
    return o[a.severity] !== o[b.severity] ? o[a.severity] - o[b.severity] : a.line - b.line;
  });
}

function literalMatch(lines, patterns, ruleId) {
  const results = [];
  const seen    = new Set();
  const excl    = RULE_EXCLUSIONS[ruleId];

  for (const pattern of patterns) {
    const patLower = pattern.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (seen.has(i)) continue;
      const line    = lines[i];
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("--") ||
          trimmed.startsWith("/*") || trimmed.startsWith("*")  ||
          trimmed.startsWith("#")  || trimmed.startsWith("@*")) continue;

      const lineLower = line.toLowerCase();
      const idx = lineLower.indexOf(patLower);
      if (idx === -1) continue;

      if (excl?.lineExclusions?.length > 0) {
        if (excl.lineExclusions.some(p => lineLower.includes(p.toLowerCase()))) continue;
      }

      seen.add(i);
      results.push({ line: i, colStart: idx,
        colEnd: Math.min(idx + pattern.length, line.length),
        matchedText: line.trim() });
    }
  }
  return results;
}

function keywordMatch(lines, patterns, ruleId) {
  const results = [];
  const seen    = new Set();
  const excl    = RULE_EXCLUSIONS[ruleId];

  for (const pattern of patterns) {
    const keywords = tokenise(pattern);
    if (keywords.length === 0) continue;

    for (let i = 0; i < lines.length; i++) {
      if (seen.has(i)) continue;
      const line      = lines[i];
      const trimmed   = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("--") ||
          trimmed.startsWith("/*") || trimmed.startsWith("*")  ||
          trimmed.startsWith("#")  || trimmed.startsWith("@*")) continue;

      const lineLower = line.toLowerCase();
      let hit = -1, hitLen = 0;

      for (const kw of keywords) {
        const idx = lineLower.indexOf(kw.toLowerCase());
        if (idx === -1) continue;
        if (excl?.lineExclusions?.some(p => lineLower.includes(p.toLowerCase()))) break;
        hit = idx; hitLen = kw.length; break;
      }
      if (hit === -1) continue;
      seen.add(i);
      results.push({ line: i, colStart: hit,
        colEnd: Math.min(hit + hitLen, line.length),
        matchedText: line.trim() });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 3: Send violations to Gemini for confirmation + explanation
//  Gemini CANNOT add new violations — it can only confirm/remove
//  violations already found by the rules engine.
// ═══════════════════════════════════════════════════════════════
function buildGeminiPrompt(codeContent, violations, languageId) {
  const violationList = violations.map((v, i) =>
    `${i + 1}. RuleId: ${v.ruleId} | Severity: ${v.severity.toUpperCase()}\n` +
    `   Title: ${v.title}\n` +
    `   Line ${v.line}: ${v.matchedText}\n` +
    `   Rule says: ${v.message}\n` +
    `   Rule fix: ${v.fix}`
  ).join("\n\n");

  return `You are a code review assistant. The static analysis engine has already detected the following potential violations in this ${languageId} code using predefined rules.

Your job is to:
1. CONFIRM each violation (is it a real problem in context?)
2. Write a CLEAR one-line explanation of why it is a problem
3. Write a SHORT actionable fix specific to the actual code snippet

IMPORTANT CONSTRAINTS:
- You MUST NOT add new violations not in the list below
- You MUST NOT change RuleId, title, or severity values  
- If a violation is a false positive, set "confirmed": false and explain why
- Only return violations from the list below

DETECTED VIOLATIONS (${violations.length} total):
${violationList}

SOURCE CODE (${languageId}):
${codeContent}

Return ONLY a JSON object in this exact shape (no markdown, no code fences):
{
  "confirmedViolations": [
    {
      "ruleId":      "<same RuleId from above>",
      "title":       "<same Title from above>",
      "severity":    "<same severity from above>",
      "category":    "<same category from above>",
      "line":        <same line number>,
      "snippet":     "<the exact offending code from that line>",
      "message":     "<same message from above>",
      "fix":         "<same fix from above>",
      "explanation": "<your one-line explanation of WHY this specific code is a problem>",
      "actionableFix":"<specific fix for THIS code snippet>",
      "confirmed":   true
    }
  ],
  "summary": "<X errors, Y warnings, Z info — total N violations in this file>"
}`;
}

function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    if (!GEMINI_API_KEY) {
      reject(new Error("GEMINI_API_KEY is not set. Use: set GEMINI_API_KEY=your-key (CMD) or $env:GEMINI_API_KEY='your-key' (PowerShell)"));
      return;
    }

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature:      0.1,
        maxOutputTokens:  8000,
        responseMimeType: "application/json",
      },
    });

    const apiPath = `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path:     apiPath,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout:  60000,
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) { reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 300)}`)); return; }
        try {
          const parsed = JSON.parse(data);
          const text   = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (!text) { reject(new Error("Empty Gemini response.")); return; }
          const clean = text.replace(/^```[a-z]*\n?/im, "").replace(/\n?```$/im, "").trim();
          resolve(JSON.parse(clean));
        } catch (e) {
          reject(new Error(`Gemini parse error: ${e.message}\nRaw: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Gemini request timed out (60s).")); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
//  STEP 4: Diff parser — extract only added/changed lines
// ═══════════════════════════════════════════════════════════════
function parseDiff(diffText) {
  const files = [];
  let current = null;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const filename   = line.slice(6).trim();
      const ext        = path.extname(filename).toLowerCase();
      const languageId = EXT_LANG_MAP[ext];
      if (!languageId) { current = null; continue; }
      current = { filename, languageId, addedLines: [] };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push(line.slice(1));
    }
  }

  return files
    .map(f => ({ filename: f.filename, languageId: f.languageId, code: f.addedLines.join("\n") }))
    .filter(f => f.code.trim().length > 0);
}

// ═══════════════════════════════════════════════════════════════
//  STEP 5: Console report — matches VS Code panel style
// ═══════════════════════════════════════════════════════════════
function printReport(allFileResults) {
  let grandTotal = 0, grandErrors = 0, grandWarnings = 0, grandInfo = 0;

  for (const { filename, violations, geminiSummary } of allFileResults) {
    const errors   = violations.filter(v => v.severity === "error").length;
    const warnings = violations.filter(v => v.severity === "warning").length;
    const info     = violations.filter(v => v.severity === "info").length;
    grandTotal    += violations.length;
    grandErrors   += errors;
    grandWarnings += warnings;
    grandInfo     += info;

    console.log(`\n${"═".repeat(68)}`);
    console.log(`📄 FILE: ${filename}`);
    console.log(`   Rules: ${[...new Set(violations.map(v => v.category))].join(" · ") || "—"}`);
    console.log(`   🔴 ${errors} Errors   🟡 ${warnings} Warnings   🔵 ${info} Info   Total: ${violations.length}`);
    if (geminiSummary) console.log(`   📝 ${geminiSummary}`);
    console.log(`${"─".repeat(68)}`);

    if (violations.length === 0) {
      console.log("   ✅ No violations found.");
      continue;
    }

    // Group by category like the VS Code panel
    const byCategory = {};
    for (const v of violations) {
      if (!byCategory[v.category]) byCategory[v.category] = [];
      byCategory[v.category].push(v);
    }

    for (const [cat, catViolations] of Object.entries(byCategory)) {
      console.log(`\n   🔒 ${cat.toUpperCase()}  (${catViolations.length})`);
      for (const v of catViolations) {
        const icon = v.severity === "error" ? "🔴" : v.severity === "warning" ? "🟡" : "🔵";
        const sev  = v.severity.toUpperCase().padEnd(7);
        console.log(`\n   ${icon} ${v.ruleId}  ${v.title}                    [${sev}]`);
        console.log(`      ⚠️  ${v.message}`);
        console.log(`      💡 Fix: ${v.actionableFix || v.fix}`);
        if (v.explanation) console.log(`      ℹ️  ${v.explanation}`);
        console.log(`      📍 Line ${v.line}: ${v.snippet || v.matchedText}`);
      }
    }
  }

  console.log(`\n${"═".repeat(68)}`);
  console.log(`TOTAL:  🔴 ${grandErrors} Errors  🟡 ${grandWarnings} Warnings  🔵 ${grandInfo} Info  =  ${grandTotal} violations`);
  if (grandTotal > 0) {
    console.log("❌  PR FAILED — fix violations before merging.");
    process.exitCode = 1;
  } else {
    console.log("✅  PR PASSED — no violations found.");
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 6: GitHub Actions PR comment formatter
// ═══════════════════════════════════════════════════════════════
function buildGithubComment(allFileResults) {
  let md = "## 🛡️ Sentinels Code Analysis\n\n";

  let grandErrors = 0, grandWarnings = 0, grandInfo = 0;
  for (const { violations } of allFileResults) {
    grandErrors   += violations.filter(v => v.severity === "error").length;
    grandWarnings += violations.filter(v => v.severity === "warning").length;
    grandInfo     += violations.filter(v => v.severity === "info").length;
  }
  const grandTotal = grandErrors + grandWarnings + grandInfo;

  md += `> 🔴 **${grandErrors} Errors** &nbsp; 🟡 **${grandWarnings} Warnings** &nbsp; 🔵 **${grandInfo} Info** &nbsp; — &nbsp; **Total: ${grandTotal}**\n\n`;

  if (grandTotal === 0) {
    md += "✅ **No violations found. PR is clean!**\n";
    return md;
  }

  for (const { filename, violations, geminiSummary } of allFileResults) {
    if (violations.length === 0) continue;

    const rules = [...new Set(violations.map(v => v.category))].map(c => `\`${c}\``).join(" ");
    md += `### 📄 \`${filename}\`\n`;
    md += `**Rules checked:** ${rules}\n\n`;
    if (geminiSummary) md += `> ${geminiSummary}\n\n`;

    // Group by category
    const byCategory = {};
    for (const v of violations) {
      if (!byCategory[v.category]) byCategory[v.category] = [];
      byCategory[v.category].push(v);
    }

    for (const [cat, catViolations] of Object.entries(byCategory)) {
      md += `#### 🔒 ${cat} (${catViolations.length})\n\n`;
      for (const v of catViolations) {
        const icon = v.severity === "error" ? "🔴" : v.severity === "warning" ? "🟡" : "🔵";
        md += `${icon} **[${v.ruleId}] ${v.title}** — \`${v.severity.toUpperCase()}\` — Line ${v.line}\n`;
        md += `- ⚠️ **Problem:** ${v.message}\n`;
        md += `- 📍 **Code:** \`${(v.snippet || v.matchedText || "").replace(/`/g, "'")}\`\n`;
        if (v.explanation) md += `- ℹ️ **Why:** ${v.explanation}\n`;
        md += `- 💡 **Fix:** ${v.actionableFix || v.fix}\n\n`;
      }
    }
    md += "---\n\n";
  }

  return md;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  const args      = process.argv.slice(2);
  let diffPath    = null;
  let filePath    = null;
  let outputPath  = null;
  let forceLang   = null;
  let noGemini    = false;
  let commentPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--diff")    diffPath    = args[++i];
    if (args[i] === "--file")    filePath    = args[++i];
    if (args[i] === "--output")  outputPath  = args[++i];
    if (args[i] === "--lang")    forceLang   = args[++i];
    if (args[i] === "--comment") commentPath = args[++i];
    if (args[i] === "--no-gemini") noGemini  = true;
  }

  if (!diffPath && !filePath) {
    console.log("Usage:");
    console.log("  node pr-analyzer.js --file src\\app.js");
    console.log("  node pr-analyzer.js --diff changes.diff --output report.json");
    console.log("  node pr-analyzer.js --file src\\app.js --no-gemini");
    console.log("\nWindows CMD:        set GEMINI_API_KEY=AIzaSy...");
    console.log("Windows PowerShell: $env:GEMINI_API_KEY=\"AIzaSy...\"");
    process.exit(1);
  }

  // Build list of files to analyze
  let filesToAnalyze = [];

  if (diffPath) {
    console.log(`\n[Sentinels] Parsing diff: ${diffPath}`);
    const diffText = fs.readFileSync(diffPath, "utf8");
    filesToAnalyze = parseDiff(diffText);
    if (filesToAnalyze.length === 0) {
      console.log("[Sentinels] No supported files found in diff.");
      process.exit(0);
    }
  } else {
    const ext        = path.extname(filePath).toLowerCase();
    const languageId = forceLang || EXT_LANG_MAP[ext];
    if (!languageId) {
      console.error(`[Sentinels] Unsupported file type: ${ext}`);
      console.error(`Supported: .js .jsx .ts .tsx .cs .sql .cshtml .html`);
      process.exit(1);
    }
    filesToAnalyze = [{
      filename:   path.basename(filePath),
      languageId,
      code:       fs.readFileSync(filePath, "utf8"),
    }];
  }

  const allFileResults = [];

  for (const { filename, languageId, code } of filesToAnalyze) {
    console.log(`\n${"─".repeat(68)}`);
    console.log(`[Sentinels] Analyzing: ${filename}  (${languageId})`);

    // STEP 1: Load rules
    const rules = loadRulesForLanguage(languageId);
    if (rules.length === 0) {
      console.warn(`  ⚠️  No rules loaded for ${languageId} — skipping.`);
      continue;
    }
    console.log(`  📋 ${rules.length} rules loaded`);

    // STEP 2: Run local rules engine (same as VS Code extension)
    const rawViolations = runRulesEngine(code, languageId, rules);
    console.log(`  🔍 Rules engine found: ${rawViolations.length} violation(s)`);

    if (rawViolations.length === 0) {
      allFileResults.push({ filename, languageId, violations: [], geminiSummary: "No violations found." });
      continue;
    }

    // STEP 3: Gemini confirmation + explanation
    let finalViolations = rawViolations.map(v => ({ ...v, snippet: v.matchedText }));
    let geminiSummary   = null;

    if (!noGemini && GEMINI_API_KEY) {
      try {
        console.log(`  🤖 Sending ${rawViolations.length} violation(s) to Gemini for confirmation...`);
        const prompt   = buildGeminiPrompt(code, rawViolations, languageId);
        const response = await callGemini(prompt);

        const confirmed = (response.confirmedViolations || []).filter(v => v.confirmed !== false);
        geminiSummary   = response.summary || null;

        // Merge Gemini's explanation+actionableFix back into our violations
        finalViolations = rawViolations.map(orig => {
          const geminiMatch = confirmed.find(g => g.ruleId === orig.ruleId && g.line === orig.line);
          if (!geminiMatch) return { ...orig, snippet: orig.matchedText }; // keep even if not matched
          return {
            ...orig,
            snippet:       geminiMatch.snippet       || orig.matchedText,
            explanation:   geminiMatch.explanation   || "",
            actionableFix: geminiMatch.actionableFix || orig.fix,
          };
        });

        console.log(`  ✅ Gemini confirmed: ${confirmed.length} violation(s)`);
      } catch (e) {
        console.warn(`  ⚠️  Gemini unavailable (${e.message}) — using rules-only results`);
      }
    } else if (!noGemini && !GEMINI_API_KEY) {
      console.warn(`  ⚠️  No GEMINI_API_KEY set — running in rules-only mode`);
      console.warn(`      CMD:        set GEMINI_API_KEY=AIzaSy...`);
      console.warn(`      PowerShell: $env:GEMINI_API_KEY="AIzaSy..."`);
    }

    allFileResults.push({ filename, languageId, violations: finalViolations, geminiSummary });
  }

  // Print console report
  printReport(allFileResults);

  // Save JSON report
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(allFileResults, null, 2), "utf8");
    console.log(`\n📄 JSON report saved: ${outputPath}`);
  }

  // Save GitHub comment markdown
  if (commentPath) {
    const md = buildGithubComment(allFileResults);
    fs.writeFileSync(commentPath, md, "utf8");
    console.log(`📝 GitHub comment saved: ${commentPath}`);
  }
}

main().catch(e => {
  console.error("[Sentinels] Fatal:", e.message);
  process.exit(1);
});
