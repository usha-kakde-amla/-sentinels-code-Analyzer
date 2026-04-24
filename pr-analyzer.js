#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = require("minimist")(process.argv.slice(2));

const diffFile = args.diff;
const outputFile = args.output || "analysis-report.json";
const rulesDir = process.env.RULES_DIR;

if (!diffFile || !fs.existsSync(diffFile)) {
    console.error("❌ Diff file missing:", diffFile);
    process.exit(1);
}
if (!rulesDir || !fs.existsSync(rulesDir)) {
    console.error("❌ Rules folder missing:", rulesDir);
    process.exit(1);
}

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
    "SEC001": ["password =", "Password =", "apiKey =", "APIKey =", "secret =", "Secret =", "connectionString ="],
    "SEC002": ["+ userId", "+ id ", "+ input", "+ userInput", '" + "', "' + '"],
    "SEC007": ["new MD5", "MD5.Create", "new SHA1", "SHA1.Create", "new DES", "DESCryptoServiceProvider"],
    "SEC008": ["log(password", "log(Password", "log(token", "log(Token", "Write(password"],
    "SEC012": ["new Random()", "new System.Random()"],
    "SEC025": ["AllowAnyOrigin()", ".AllowAnyOrigin"],
    "VUL001": ["+ userId", "+ id ", "+ username", '+ "SELECT', '+ @name', 'ExecuteNonQuery("SELECT'],
    "VUL002": ['= "password"', '= "Password"', '= "secret"', '= "apikey"', 'apiKey = "'],
    "VUL003": ["new MD5CryptoServiceProvider", "new SHA1CryptoServiceProvider", "new DESCryptoServiceProvider"],
    "VUL004": ["File.ReadAllText(userInput", "File.ReadAllText(input", "Path.Combine(userInput", "+ userInput"],
    "VUL005": ["BinaryFormatter", ".Deserialize(stream", ".Deserialize(input"],
    "VUL006": ["db.Users.Remove", "db.Delete", "repository.Delete"],
    "VUL009": ["http://api.", "http://www.", 'GetAsync("http:', 'PostAsync("http:'],
    "VUL011": ['Response.Write("<', "innerHTML =", ".innerHTML ="],
    "VUL012": ["new Random()", "rng.Next()", "new System.Random"],
    "PERF101": ["executeQuery(", "ExecuteQuery(", "ExecuteNonQuery(", "db.Query(", ".Find(", ".FirstOrDefault("],
    "PERF105": ["getUserData(userId)", "getUser(id)", "fetchData(id)"],
    "PERF107": ["JSON.parse(", "JsonSerializer.Deserialize(", "XmlSerializer"],
    "PERF108": [".Count()", ".count()"],
    "JS_SEC002": ["eval(", "new Function("],
    "JS_SEC003": ["innerHTML =", "dangerouslySetInnerHTML"],
    "JS_SEC005": ["child_process.exec(", "exec(cmd", "spawn(cmd"],
    "JS_PERF001": ["while(true)", "for(;;)"],
    "JS_PERF004": ["console.log(", "console.debug("],
    "TS_SEC003": ["as unknown as"],
    "TS_PERF003": ["JSON.parse(JSON.stringify("],
    "CSHTML004": ["@Html.Raw(", "Html.Raw("],
    "CSHTML005": ["@ViewBag.", "@ViewData["],
    "CSHTML007": ['<form method="post"', "<form method='post'"],
};

// Load rules
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

// Parse diff — track fileLine (real line number in new file)
const diffLines = fs.readFileSync(diffFile, "utf8").split("\n");
let currentFile = "unknown";
let fileLine = 0;
let inHunk = false;
const issueMap = new Map();

diffLines.forEach((line) => {
    if (line.startsWith("+++ b/")) {
        currentFile = line.replace("+++ b/", "").trim();
        inHunk = false;
        return;
    }
    if (line.startsWith("--- ") || line.startsWith("diff ") || line.startsWith("index ")) return;

    if (line.startsWith("@@")) {
        inHunk = true;
        const match = line.match(/\+(\d+)/);
        fileLine = match ? parseInt(match[1], 10) - 1 : 0;
        return;
    }

    if (!inHunk) return;

    if (!line.startsWith("+") && !line.startsWith("-")) {
        fileLine++;
        return;
    }

    if (line.startsWith("-")) return;

    // Added line
    fileLine++;
    const cleanLine = line.slice(1);
    const cleanLower = cleanLine.toLowerCase();
    const trimmed = cleanLine.trimStart();

    if (trimmed.startsWith("//") || trimmed.startsWith("--") ||
        trimmed.startsWith("/*") || trimmed.startsWith("*") ||
        trimmed.startsWith("#") || trimmed.startsWith("@*")) return;

    rules.forEach(rule => {
        const ruleId = rule.RuleId || rule.id;
        if (!ruleId) return;

        let matched = false;
        const overrides = DETECTION_OVERRIDES[ruleId];
        if (overrides) {
            matched = overrides.some(p => cleanLower.includes(p.toLowerCase()));
        } else {
            const det = rule.Detection;
            if (Array.isArray(det)) {
                matched = det.some(k => k && cleanLower.includes(k.toLowerCase()));
            } else if (typeof det === "string" && det.trim().length > 0) {
                const tokens = [...det.matchAll(/["'`]([^"'`]{2,60})["'`]/g)].map(m => m[1]);
                matched = tokens.length > 0
                    ? tokens.some(k => cleanLower.includes(k.toLowerCase()))
                    : cleanLower.includes(det.toLowerCase().slice(0, 40));
            }
        }

        if (matched) {
            const key = `${currentFile}::${fileLine}::${ruleId}`;
            if (!issueMap.has(key)) {
                issueMap.set(key, {
                    ruleId,
                    title: rule.Title || rule.name || ruleId,
                    message: rule.Message || rule.description || "",
                    fix: rule.Fix || rule.compliantExample || "",
                    severity: rule.Severity || "Info",
                    category: rule._category,
                    file: currentFile,
                    fileLine,   // ← real line number used by workflow to post inline comment
                    snippet: cleanLine.trim()
                });
            }
        }
    });
});

const issues = [...issueMap.values()];
fs.writeFileSync(outputFile, JSON.stringify(issues, null, 2));
console.log(`📄 Report: ${outputFile} — ${issues.length} issue(s)`);
issues.forEach(i => console.log(`  ${i.severity} | ${i.file}:${i.fileLine} | ${i.ruleId}`));

const hasErrors = issues.some(i => i.severity.toLowerCase() === "error");
process.exit(hasErrors ? 1 : 0);