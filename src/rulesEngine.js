// ═══════════════════════════════════════════════════════════════
//  rulesEngine.js  — v3
//  Two-mode pattern matching:
//    • LITERAL mode  — DETECTION_OVERRIDES use exact substring match
//                      (preserves "SELECT *", "EXEC(@", etc.)
//    • KEYWORD mode  — fallback for rules without overrides
//  Exclusion maps prevent false positives on correct code.
// ═══════════════════════════════════════════════════════════════

"use strict";

// ── Language → Category ────────────────────────────────────────
const LANGUAGE_CATEGORY_MAP = {
  "csharp":            ["Security", "Vulnerability", "Performance"],
  "sql":               ["SQL"],
  "tsql":              ["SQL"],
  "typescript":        ["Typescript"],
  "typescriptreact":   ["Typescript"],
  "javascript":        ["Javascript"],
  "javascriptreact":   ["Javascript"],
  "razor":             ["CSHTML"],
  "aspnetcorerazor":   ["CSHTML"],
  "html":              ["CSHTML"],
};

// ── Detection overrides (LITERAL substring matching) ───────────
// These replace the JSON Detection strings with exact bad-code tokens.
// The engine does plain case-insensitive indexOf — no tokenisation.
const DETECTION_OVERRIDES = {
  // SQL rules
  "TSQL001": ["SELECT *", "SELECT*"],
  "TSQL004": ["INSERT INTO", "UPDATE ", "DELETE FROM", "MERGE INTO"],
  "TSQL005": ["UPDATE ", "DELETE FROM", "INSERT INTO"],
  "TSQL006": ["EXEC('", 'EXEC("', "' + @", "@ + '", "+ N'", "N' +", "SET @sql"],
  "TSQL007": ["EXEC(@", "EXEC (@", "EXECUTE(@", "EXECUTE (@"],
  "TSQL008": ["YEAR(", "MONTH(", "DAY(", "CONVERT(CHAR", "UPPER(", "LOWER(", "ISNULL("],
  "TSQL009": ["CURSOR FOR", "FETCH NEXT", "OPEN cursor", "DECLARE CURSOR"],
  "TSQL010": ["EXECUTE AS LOGIN", "EXECUTE AS USER", "EXECUTE AS OWNER"],
  "TSQL011": ["CreditCardNumber", "SocialSecurityNumber", "SSN", "CVV", "AccountPassword"],

  // Security rules (C#)
  "SEC001":  ["password =", "Password =", 'apiKey =', 'APIKey =', 'secret =', 'Secret =', 'connectionString ='],
  "SEC002":  ["+ userId", "+ id ", "+ input", "+ userInput", '" + "', "' + '"],
  "SEC007":  ["new MD5", "MD5.Create", "new SHA1", "SHA1.Create", "new DES", "DESCryptoServiceProvider"],
  "SEC008":  ["log(password", "log(Password", "log(token", "log(Token", "Write(password"],
  "SEC012":  ["new Random()", "new System.Random()"],
  "SEC025":  ["AllowAnyOrigin()", ".AllowAnyOrigin"],

  // Vulnerability rules (C#)
  "VUL001":  ["+ userId", "+ id ", "+ username", '+ "SELECT', '+ @name', "ExecuteNonQuery(\"SELECT"],
  "VUL002":  ['= "password"', '= "Password"', '= "secret"', '= "apikey"', 'apiKey = "'],
  "VUL003":  ["new MD5CryptoServiceProvider", "new SHA1CryptoServiceProvider", "new DESCryptoServiceProvider"],
  "VUL004":  ["File.ReadAllText(userInput", "File.ReadAllText(input", "Path.Combine(userInput", "+ userInput"],
  "VUL005":  ["BinaryFormatter", ".Deserialize(stream", ".Deserialize(input"],
  "VUL006":  ["db.Users.Remove", "db.Delete", "repository.Delete"],
  "VUL009":  ["http://api.", "http://www.", "GetAsync(\"http:", "PostAsync(\"http:"],
  "VUL011":  ["Response.Write(\"<", "innerHTML =", ".innerHTML ="],
  "VUL012":  ["new Random()", "rng.Next()", "new System.Random"],

  // Performance rules (C#)
  "PERF101": ["executeQuery(", "ExecuteQuery(", "ExecuteNonQuery(", "db.Query(", ".Find(", ".FirstOrDefault("],
  "PERF105": ["getUserData(userId)", "getUser(id)", "fetchData(id)"],
  "PERF107": ["JSON.parse(", "JsonSerializer.Deserialize(", "XmlSerializer"],
  "PERF108": [".Count()", ".count()"],

  // JavaScript rules
  "JS_SEC002": ["eval(", "new Function("],
  "JS_SEC003": ["innerHTML =", "dangerouslySetInnerHTML"],
  "JS_SEC005": ["child_process.exec(", "exec(cmd", "spawn(cmd"],
  "JS_PERF001": ["while(true)", "for(;;)"],
  "JS_PERF004": ["console.log(", "console.debug("],

  // TypeScript rules
  "TS_SEC003": ["as unknown as"],
  "TS_PERF003": ["JSON.parse(JSON.stringify("],

  // CSHTML rules
  "CSHTML004": ["@Html.Raw(", "Html.Raw("],
  "CSHTML005": ["@ViewBag.", "@ViewData["],
  "CSHTML007": ['<form method="post"', "<form method='post'"],
};

// ── Exclusion map ──────────────────────────────────────────────
// lineExclusions: if THIS line contains any of these → skip match
// fileExclusions: if WHOLE FILE contains any of these → skip rule entirely
const RULE_EXCLUSIONS = {
  "TSQL006": {
    lineExclusions: ["sp_executesql", "sp_executeSql"],
    fileExclusions: ["sp_executesql"]          // file uses parameterised queries → skip
  },
  "TSQL007": {
    lineExclusions: ["sp_executesql", "sp_executeSql"],
    fileExclusions: []
  },
  "TSQL004": {
    lineExclusions: ["TRY", "BEGIN TRY"],
    fileExclusions: ["BEGIN TRY"]              // file has TRY/CATCH → skip
  },
  "TSQL005": {
    lineExclusions: ["@@ROWCOUNT"],
    fileExclusions: ["@@ROWCOUNT"]             // file checks rowcount → skip
  },
  "TSQL001": {
    lineExclusions: [],
    fileExclusions: []
  },
  "TSQL008": {
    lineExclusions: ["DECLARE", "NVARCHAR", "VARCHAR", "CHAR(", "PARAMETER"],
    fileExclusions: []
  },
  "TSQL009": {
    lineExclusions: ["DECLARE @"],             // DECLARE @var is not a cursor
    fileExclusions: []
  },
  "VUL009": {
    lineExclusions: ["https://"],
    fileExclusions: []
  },
  "SEC011": {
    lineExclusions: ["https", "UseHttpsRedirection"],
    fileExclusions: ["UseHttpsRedirection"]
  },
  "JS_PERF004": {
    lineExclusions: ["logger", "Logger", "winston", "pino", "//"],
    fileExclusions: []
  },
  "PERF101": {
    lineExclusions: [],
    fileExclusions: []
  },
};

// ── Stop words (used in keyword mode only) ─────────────────────
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

class RulesEngine {
  constructor() { this._rules = []; }

  setRules(rules) {
    this._rules = rules;
    console.log(`[Sentinels] Loaded ${rules.length} rules: ${[...new Set(rules.map(r=>r.category))].join(", ")}`);
  }

  ruleCount() { return this._rules.length; }
  getRules()  { return this._rules; }
  getCategoriesForLanguage(lang) { return LANGUAGE_CATEGORY_MAP[lang] || []; }

  validate(text, languageId) {
    if (!text || this._rules.length === 0) return [];
    const allowed = LANGUAGE_CATEGORY_MAP[languageId];
    if (!allowed || allowed.length === 0) return [];

    const lines      = text.split("\n");
    const textLower  = text.toLowerCase();
    const violations = [];
    const seen       = new Set();

    for (const rule of this._rules) {
      if (!allowed.includes(rule.category)) continue;

      // ── File-level exclusion ─────────────────────────────
      const excl = RULE_EXCLUSIONS[rule.id];
      if (excl?.fileExclusions?.length > 0) {
        if (excl.fileExclusions.some(p => textLower.includes(p.toLowerCase()))) continue;
      }

      // ── Choose detection mode ─────────────────────────────
      const overrides = DETECTION_OVERRIDES[rule.id];
      const matches   = overrides
        ? this._literalMatch(lines, overrides, rule.id)    // exact substring
        : this._keywordMatch(lines, rule.detection, rule.id); // tokenised

      for (const m of matches) {
        const key = `${rule.id}::${m.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({ ruleId: rule.id, title: rule.title, category: rule.category,
          severity: rule.severity, message: rule.message, fix: rule.fix, tags: rule.tags,
          line: m.line, colStart: m.colStart, colEnd: m.colEnd, matchedText: m.matchedText });
      }
    }

    return violations.sort((a, b) => {
      const o = { error: 0, warning: 1, info: 2 };
      return o[a.severity] !== o[b.severity] ? o[a.severity] - o[b.severity] : a.line - b.line;
    });
  }

  // ── LITERAL mode ───────────────────────────────────────────
  // Does plain case-insensitive indexOf — no tokenisation.
  // Preserves exact patterns like "SELECT *", "EXEC(@", etc.
  _literalMatch(lines, patterns, ruleId) {
    const results = [];
    const seen    = new Set();
    const excl    = RULE_EXCLUSIONS[ruleId];

    for (const pattern of patterns) {
      const patLower = pattern.toLowerCase();

      for (let i = 0; i < lines.length; i++) {
        if (seen.has(i)) continue;
        const line    = lines[i];
        const trimmed = line.trimStart();

        // Skip comment lines
        if (trimmed.startsWith("//") || trimmed.startsWith("--") ||
            trimmed.startsWith("/*") || trimmed.startsWith("*")  ||
            trimmed.startsWith("#")  || trimmed.startsWith("@*")) continue;

        const lineLower = line.toLowerCase();
        const idx = lineLower.indexOf(patLower);
        if (idx === -1) continue;

        // Line-level exclusion
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

  // ── KEYWORD mode ───────────────────────────────────────────
  // Tokenises the detection string and searches for tokens.
  // Used for rules without a DETECTION_OVERRIDE.
  _keywordMatch(lines, patterns, ruleId) {
    const results = [];
    const seen    = new Set();
    const excl    = RULE_EXCLUSIONS[ruleId];

    for (const pattern of patterns) {
      const keywords = this._tokenise(pattern);
      if (keywords.length === 0) continue;

      for (let i = 0; i < lines.length; i++) {
        if (seen.has(i)) continue;
        const line    = lines[i];
        const trimmed = line.trimStart();

        if (trimmed.startsWith("//") || trimmed.startsWith("--") ||
            trimmed.startsWith("/*") || trimmed.startsWith("*")  ||
            trimmed.startsWith("#")  || trimmed.startsWith("@*")) continue;

        const lineLower = line.toLowerCase();
        let hit = -1;
        let hitLen = 0;

        for (const kw of keywords) {
          const idx = lineLower.indexOf(kw.toLowerCase());
          if (idx === -1) continue;
          if (excl?.lineExclusions?.some(p => lineLower.includes(p.toLowerCase()))) break;
          hit    = idx;
          hitLen = kw.length;
          break;
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

  _tokenise(pattern) {
    const cleaned = pattern.replace(/['"`;,(){}[\]\r\n]/g, " ").replace(/\s+/g, " ").trim();
    const tokens  = cleaned.split(" ")
      .filter(t => t.length >= 4 && !STOP_WORDS.has(t.toLowerCase()))
      .filter((t, i, a) => a.indexOf(t) === i)
      .sort((a, b) => b.length - a.length)
      .slice(0, 5);
    if (tokens.length >= 2) tokens.unshift(`${tokens[0]} ${tokens[1]}`);
    return tokens;
  }
}

module.exports = RulesEngine;
