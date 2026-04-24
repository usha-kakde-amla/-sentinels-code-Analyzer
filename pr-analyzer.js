const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const diffFile = args.diff;
const outputFile = args.output || 'analysis-report.json';
const rulesDir = process.env.RULES_DIR || './rules';

if (!fs.existsSync(diffFile)) {
    console.error('❌ Diff file not found');
    process.exit(1);
}

// ✅ Load ONLY your rules
function loadRules() {
    const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
        console.error('❌ No rules found');
        process.exit(1);
    }

    let rules = [];

    for (const file of files) {
        const content = JSON.parse(fs.readFileSync(path.join(rulesDir, file), 'utf8'));
        rules = rules.concat(Array.isArray(content) ? content : [content]);
        console.log(`✅ Loaded ${file}`);
    }

    console.log(`🔍 Total rules: ${rules.length}`);
    return rules;
}

// ✅ Parse diff (important for inline comments)
function parseDiff(diff) {
    const files = [];
    let currentFile = null;
    let lineNumber = 0;

    diff.split('\n').forEach(line => {
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
            if (currentFile) {
                files[files.length - 1].lines.push({
                    lineNumber,
                    content: line.substring(1)
                });
            }
        } else if (!line.startsWith('-')) {
            lineNumber++;
        }
    });

    return files;
}

// ✅ Apply rules
function analyze(files, rules) {
    const issues = [];

    for (const file of files) {
        for (const line of file.lines) {
            for (const rule of rules) {
                if (!rule.pattern) continue;

                try {
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
                } catch (e) {
                    console.log(`⚠️ Invalid regex: ${rule.ruleId}`);
                }
            }
        }
    }

    return issues;
}

// ✅ MAIN
const rules = loadRules();
const diff = fs.readFileSync(diffFile, 'utf8');
const files = parseDiff(diff);
const issues = analyze(files, rules);

fs.writeFileSync(outputFile, JSON.stringify(issues, null, 2));

console.log(`🛡️ Issues found: ${issues.length}`);