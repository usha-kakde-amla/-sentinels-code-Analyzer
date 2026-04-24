const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));

const diffFile = args.diff;
const outputFile = args.output || 'report.json';
const rulesDir = process.env.RULES_DIR || './rules';

// ✅ LOAD RULES ONLY FROM YOUR REPO
function loadRules() {
    if (!fs.existsSync(rulesDir)) {
        console.error('❌ Rules folder not found');
        process.exit(1);
    }

    const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));

    console.log("📂 Rules files:", files);

    if (files.length === 0) {
        console.error('❌ No rules found');
        process.exit(1);
    }

    let rules = [];

    for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(rulesDir, file), 'utf8'));
        rules = rules.concat(Array.isArray(data) ? data : [data]);
    }

    console.log("🔥 Total rules loaded:", rules.length);
    return rules;
}

// ✅ PARSE DIFF
function parseDiff(diffText) {
    const lines = diffText.split('\n');
    const files = [];
    let currentFile = null;
    let lineNumber = 0;

    for (const line of lines) {
        if (line.startsWith('diff --git')) {
            const match = line.match(/b\/(.+)/);
            if (match) {
                currentFile = match[1];
                files.push({ file: currentFile, lines: [] });
            }
        } else if (line.startsWith('@@')) {
            const match = line.match(/\+(\d+)/);
            lineNumber = match ? parseInt(match[1]) - 1 : 0;
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
            lineNumber++;
            files[files.length - 1].lines.push({
                lineNumber,
                content: line.substring(1)
            });
        } else if (!line.startsWith('-')) {
            lineNumber++;
        }
    }

    return files;
}

// ✅ APPLY RULES
function analyze(files, rules) {
    const issues = [];

    for (const file of files) {
        for (const line of file.lines) {
            for (const rule of rules) {
                if (!rule.pattern) continue;

                const regex = new RegExp(rule.pattern, 'i');

                if (regex.test(line.content)) {
                    issues.push({
                        file: file.file,
                        fileLine: line.lineNumber,
                        ruleId: rule.ruleId,
                        title: rule.title,
                        message: rule.message,
                        fix: rule.fix,
                        severity: rule.severity || 'warning'
                    });
                }
            }
        }
    }

    return issues;
}

// ✅ RUN
const rules = loadRules();
const diffText = fs.readFileSync(diffFile, 'utf8');
const files = parseDiff(diffText);
const issues = analyze(files, rules);

fs.writeFileSync(outputFile, JSON.stringify(issues, null, 2));

console.log(`🛡️ Issues found: ${issues.length}`);