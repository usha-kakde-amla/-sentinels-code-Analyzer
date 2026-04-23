#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = require("minimist")(process.argv.slice(2));

// ==========================
// INPUTS
// ==========================
const diffFile = args.diff;
const outputFile = args.output || "analysis-report.json";
const commentFile = args.comment || "pr-comment.md";
const rulesDir = process.env.RULES_DIR;

// ==========================
// VALIDATION
// ==========================
if (!diffFile || !fs.existsSync(diffFile)) {
    console.error("❌ Diff file missing:", diffFile);
    process.exit(1);
}
if (!rulesDir || !fs.existsSync(rulesDir)) {
    console.error("❌ Rules folder missing:", rulesDir);
    process.exit(1);
}

// ==========================
// DETECTION OVERRIDES
// Mirrors rulesEngine.js DETECTION_OVERRIDES — exact substring matching
// for rules where keyword matching is too broad or too narrow.
// ==========================
const DETECTION_OVERRIDES = {
    // SQL
    "TSQL001": ["SELECT *", "SELECT*"],
    "TSQL004": ["INSERT INTO", "UPDATE ", "DELETE FROM", "MERGE INTO"],
    "TSQL005": ["UPDATE ", "DELETE FROM", "INSERT INTO"],
    "TSQL006": ["EXEC('", 'EXEC("', "' + @", "@ + '", "+ N'", "N' +", "SET @sql"],
    "TSQL007": ["EXEC(@", "EXEC (@", "EXECUTE(@", "EXECUTE (@"],
    "TSQL008": ["YEAR(", "MONTH(", "DAY(", "CONVERT(CHAR", "UPPER(", "LOWER(", "ISNULL("],
    "TSQL009": ["CURSOR FOR", "FETCH NEXT", "OPEN cursor", "DECLARE CURSOR"],
    "TSQL010": ["EXECUTE AS LOGIN", "EXECUTE AS USER", "EXECUTE AS OWNER"],
    "TSQL011": ["CreditCardNumber", "SocialSecurityNumber", "SSN", "CVV", "AccountPassword"],
    // Security (C#)
    "SEC001": ["password =", "Password =", "apiKey =", "APIKey =", "secret =", "Secret =", "connectionString ="],
    "SEC002": ["+ userId", "+ id ", "+ input", "+ userInput", '" + "', "' + '"],
    "SEC007": ["new MD5", "MD5.Create", "new SHA1", "SHA1.Create", "new DES", "DESCryptoServiceProvider"],
    "SEC008": ["log(password", "log(Password", "log(token", "log(Token", "Write(password"],
    "SEC012": ["new Random()", "new System.Random()"],
    "SEC025": ["AllowAnyOrigin()", ".AllowAnyOrigin"],
    // Vulnerability (C#)
    "VUL001": ["+ userId", "+ id ", "+ username", '+ "SELECT', '+ @name', 'ExecuteNonQuery("SELECT'],
    "VUL002": ['= "password"', '= "Password"', '= "secret"', '= "apikey"', 'apiKey = "'],
    "VUL003": ["new MD5CryptoServiceProvider", "new SHA1CryptoServiceProvider", "new DESCryptoServiceProvider"],
    "VUL004": ["File.ReadAllText(userInput", "File.ReadAllText(input", "Path.Combine(userInput", "+ userInput"],
    "VUL005": ["BinaryFormatter", ".Deserialize(stream", ".Deserialize(input"],
    "VUL006": ["db.Users.Remove", "db.Delete", "repository.Delete"],
    "VUL009": ["http://api.", "http://www.", 'GetAsync("http:', 'PostAsync("http:'],
    "VUL011": ['Response.Write("<', "innerHTML =", ".innerHTML ="],
    "VUL012": ["new Random()", "rng.Next()", "new System.Random"],
    // Performance (C#)
    "PERF101": ["executeQuery(", "ExecuteQuery(", "ExecuteNonQuery(", "db.Query(", ".Find(", ".FirstOrDefault("],
    "PERF105": ["getUserData(userId)", "getUser(id)", "fetchData(id)"],
    "PERF107": ["JSON.parse(", "JsonSerializer.Deserialize(", "XmlSerializer"],
    "PERF108": [".Count()", ".count()"],
    // JavaScript
    "JS_SEC002": ["eval(", "new Function("],
    "JS_SEC003": ["innerHTML =", "dangerouslySetInnerHTML"],
    "JS_SEC005": ["child_process.exec(", "exec(cmd", "spawn(cmd"],
    "JS_PERF001": ["while(true)", "for(;;)"],
    "JS_PERF004": ["console.log(", "console.debug("],
    // TypeScript
    "TS_SEC003": ["as unknown as"],
    "TS_PERF003": ["JSON.parse(JSON.stringify("],
    // CSHTML
    "CSHTML004": ["@Html.Raw(", "Html.Raw("],
    "CSHTML005": ["@ViewBag.", "@ViewData["],
    "CSHTML007": ['<form method="post"', "<form method='post'"],
};

// ==========================
// LOAD RULES
// Flattens all JSON files — handles both array and string Detection fields
// (Security/Javascript/Typescript have array, Vulnerability/SQL/CSHTML have string)
// ==========================
const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith(".json"));
if (ruleFiles.length === 0) {
    console.error("❌ No rules found in:", rulesDir);
    process.exit(1);
}

const rules = [];
ruleFiles.forEach(file => {
    try {
        const category = path.basename(file, ".json");
        const data = JSON.parse(fs.readFileSync(path.join(rulesDir, file), "utf8"));
        const items = Array.isArray(data) ? data : (data.rules || []);
        items.forEach(r => rules.push({ ...r, _category: category }));
    } catch (e) {
        console.warn(`⚠️ Skipping invalid rule file: ${file}`);
    }
});

console.log(`✅ Loaded ${rules.length} rules from ${ruleFiles.length} files`);

// ==========================
// READ DIFF (line by line)
// ==========================
const diffLines = fs.readFileSync(diffFile, "utf8").split("\n");
let currentFile = "unknown";

// ==========================
// APPLY RULES
// For each added line, check DETECTION_OVERRIDES first (exact match),
// then fall back to the rule's Detection array/string keywords.
// ==========================
let issueMap = new Map();

diffLines.forEach((line, index) => {
    if (line.startsWith("+++ b/")) {
        currentFile = line.replace("+++ b/", "").trim();
        return;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) return;

    const cleanLine = line.slice(1);
    const cleanLower = cleanLine.toLowerCase();

    // Skip comment lines
    const trimmed = cleanLine.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("--") ||
        trimmed.startsWith("/*") || trimmed.startsWith("*") ||
        trimmed.startsWith("#") || trimmed.startsWith("@*")) return;

    rules.forEach(rule => {
        const ruleId = rule.RuleId || rule.id;
        if (!ruleId) return;

        let matched = false;

        // Mode 1 — DETECTION_OVERRIDES (exact substring, same as rulesEngine.js)
        const overrides = DETECTION_OVERRIDES[ruleId];
        if (overrides) {
            matched = overrides.some(p => cleanLower.includes(p.toLowerCase()));
        } else {
            // Mode 2 — Detection field (array or string)
            const det = rule.Detection;
            if (Array.isArray(det)) {
                matched = det.some(k => k && cleanLower.includes(k.toLowerCase()));
            } else if (typeof det === "string" && det.trim().length > 0) {
                // For string Detection, extract quoted tokens as keywords
                const tokens = [...det.matchAll(/["'`]([^"'`]{2,60})["'`]/g)].map(m => m[1]);
                if (tokens.length > 0) {
                    matched = tokens.some(k => cleanLower.includes(k.toLowerCase()));
                } else {
                    // Last resort: plain substring of the Detection string itself
                    matched = cleanLower.includes(det.toLowerCase().slice(0, 40));
                }
            }
        }

        if (matched) {
            const key = `${ruleId}::${index}`;
            if (!issueMap.has(key)) {
                issueMap.set(key, {
                    ruleId,
                    title: rule.Title || rule.name || ruleId,
                    message: rule.Message || rule.description || "",
                    fix: rule.Fix || rule.compliantExample || "",
                    severity: rule.Severity || "Info",
                    category: rule._category,
                    file: currentFile,
                    line: index + 1,
                    snippet: cleanLine.trim()
                });
            }
        }
    });
});

const issues = [...issueMap.values()];

// ==========================
// SAVE REPORT
// ==========================
fs.writeFileSync(outputFile, JSON.stringify(issues, null, 2));
console.log(`📄 Report saved: ${outputFile} (${issues.length} issues)`);

// ==========================
// GENERATE PR COMMENT
// ==========================
const severityIcon = { error: "🔴", warning: "🟡", info: "🔵" };

let comment = "## 🛡️ Sentinels Code Analysis\n\n";

if (issues.length === 0) {
    comment += "✅ **No issues found. Great work!**\n";
} else {
    // Summary table
    const errors = issues.filter(i => i.severity.toLowerCase() === "error").length;
    const warnings = issues.filter(i => i.severity.toLowerCase() === "warning").length;
    const infos = issues.filter(i => i.severity.toLowerCase() === "info").length;

    comment += `| 🔴 Errors | 🟡 Warnings | 🔵 Info |\n`;
    comment += `|-----------|-------------|----------|\n`;
    comment += `| ${errors} | ${warnings} | ${infos} |\n\n`;

    // Group by file
    const byFile = issues.reduce((acc, issue) => {
        acc[issue.file] = acc[issue.file] || [];
        acc[issue.file].push(issue);
        return acc;
    }, {});

    Object.entries(byFile).forEach(([file, fileIssues]) => {
        comment += `### 📁 \`${file}\`\n\n`;
        fileIssues.forEach(issue => {
            const icon = severityIcon[issue.severity.toLowerCase()] || "⚪";
            comment += `#### ${icon} [${issue.ruleId}] ${issue.title}\n`;
            comment += `- **Severity:** ${issue.severity}\n`;
            comment += `- **Line:** ${issue.line}\n`;
            comment += `- **Issue:** ${issue.message}\n`;
            comment += `- **Fix:** ${issue.fix}\n`;
            if (issue.snippet) {
                comment += `\`\`\`\n${issue.snippet}\n\`\`\`\n`;
            }
            comment += `\n---\n\n`;
        });
    });
}

fs.writeFileSync(commentFile, comment);
console.log(`💬 PR comment saved: ${commentFile}`);

// ==========================
// EXIT CODE — only fail on Errors
// ==========================
const hasErrors = issues.some(i => i.severity.toLowerCase() === "error");
process.exit(hasErrors ? 1 : 0);