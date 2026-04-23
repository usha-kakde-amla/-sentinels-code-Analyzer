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
// LOAD RULES
// ==========================
const ruleFiles = fs.readdirSync(rulesDir).filter(f => f.endsWith(".json"));
if (ruleFiles.length === 0) {
    console.error("❌ No rules found in:", rulesDir);
    process.exit(1);
}

const rules = ruleFiles.map(file => {
    try {
        return JSON.parse(fs.readFileSync(path.join(rulesDir, file), "utf8"));
    } catch (e) {
        console.warn(`⚠️ Skipping invalid rule file: ${file}`);
        return null;
    }
}).filter(Boolean);

console.log(`✅ Loaded ${rules.length} rules`);

// ==========================
// READ DIFF (line by line)
// ==========================
const diffLines = fs.readFileSync(diffFile, "utf8").split("\n");
let currentFile = "unknown";

// ==========================
// APPLY RULES
// ==========================
let issueMap = new Map(); // ruleId+line -> issue (prevent duplicates)

diffLines.forEach((line, index) => {
    // Track current file from diff headers
    if (line.startsWith("+++ b/")) {
        currentFile = line.replace("+++ b/", "").trim();
        return;
    }

    // Only scan newly added lines
    if (!line.startsWith("+") || line.startsWith("+++")) return;

    const cleanLine = line.slice(1); // remove leading "+"

    rules.forEach(rule => {
        if (!rule.Detection) return;

        rule.Detection.forEach(keyword => {
            if (cleanLine.toLowerCase().includes(keyword.toLowerCase())) {
                const key = `${rule.RuleId}::${index}`; // unique per rule+line
                if (!issueMap.has(key)) {
                    issueMap.set(key, {
                        ruleId: rule.RuleId,
                        title: rule.Title,
                        message: rule.Message,
                        fix: rule.Fix,
                        severity: rule.Severity || "Info",
                        file: currentFile,
                        line: index + 1,
                        snippet: cleanLine.trim()
                    });
                }
            }
        });
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