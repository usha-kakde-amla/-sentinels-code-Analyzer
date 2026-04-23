#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const args = require("minimist")(process.argv.slice(2));

// Inputs
const diffFile = args.diff;
const outputFile = args.output || "analysis-report.json";
const commentFile = args.comment || "pr-comment.md";
const rulesDir = process.env.RULES_DIR;

// ==========================
// VALIDATION
// ==========================
if (!fs.existsSync(diffFile)) {
    console.error("❌ Diff file missing");
    process.exit(1);
}

if (!fs.existsSync(rulesDir)) {
    console.error("❌ Rules folder missing:", rulesDir);
    process.exit(1);
}

// ==========================
// LOAD RULES
// ==========================
const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith(".json"));

if (ruleFiles.length === 0) {
    console.error("❌ No rules found");
    process.exit(1);
}

const rules = ruleFiles.map(file =>
    JSON.parse(fs.readFileSync(path.join(rulesDir, file), "utf8"))
);

console.log(`✅ Loaded ${rules.length} rules`);

// ==========================
// READ DIFF
// ==========================
const diff = fs.readFileSync(diffFile, "utf8").toLowerCase();

// ==========================
// APPLY RULES
// ==========================
let issues = [];

rules.forEach(rule => {
    if (!rule.Detection) return;

    rule.Detection.forEach(keyword => {
        if (diff.includes(keyword.toLowerCase())) {
            issues.push({
                ruleId: rule.RuleId,
                title: rule.Title,
                message: rule.Message,
                fix: rule.Fix,
                severity: rule.Severity || "Info"
            });
        }
    });
});

// Remove duplicates
issues = [...new Map(issues.map(i => [i.ruleId, i])).values()];

// ==========================
// SAVE REPORT
// ==========================
fs.writeFileSync(outputFile, JSON.stringify(issues, null, 2));

// ==========================
// GENERATE PR COMMENT
// ==========================
let comment = "## 🛡️ Sentinels Code Analysis\n\n";

if (issues.length === 0) {
    comment += "✅ No issues found.\n";
} else {
    comment += `🔍 Total Issues: ${issues.length}\n\n`;

    issues.forEach(issue => {
        comment += `### [${issue.ruleId}] ${issue.title}\n`;
        comment += `Severity: ${issue.severity}\n\n`;
        comment += `Issue: ${issue.message}\n\n`;
        comment += `Fix: ${issue.fix}\n\n`;
        comment += `---\n\n`;
    });
}

fs.writeFileSync(commentFile, comment);

// ==========================
// EXIT CODE
// ==========================
process.exit(issues.length > 0 ? 1 : 0);