const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const args = minimist(process.argv.slice(2));

const diffFile = args.diff;
const outputFile = args.output || 'report.json';
const rulesDir = args.rules || './rules';

if (!fs.existsSync(diffFile)) {
    console.error("❌ Diff file not found");
    process.exit(1);
}

const diff = fs.readFileSync(diffFile, 'utf8');

// =======================
// LOAD RULES
// =======================
let rules = [];

if (fs.existsSync(rulesDir)) {
    const files = fs.readdirSync(rulesDir);

    for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
            const data = JSON.parse(fs.readFileSync(path.join(rulesDir, file), 'utf8'));
            const arr = Array.isArray(data) ? data : [data];

            for (const r of arr) {
                if (!r.ruleId || !r.pattern) continue;

                rules.push({
                    ruleId: r.ruleId,
                    title: r.title,
                    description: r.description || '',
                    severity: r.severity || 'Info',
                    pattern: new RegExp(r.pattern, 'i'),
                    fix: r.fix || ''
                });
            }
        } catch (e) {
            console.log(`❌ Failed to load ${file}: ${e.message}`);
        }
    }
}

console.log(`✅ Loaded ${rules.length} rules`);

// =======================
// PARSE DIFF
// =======================
const lines = diff.split('\n');

let currentFile = '';
let lineNumber = 0;
const issues = [];

for (const line of lines) {
    if (line.startsWith('+++ b/')) {
        currentFile = line.replace('+++ b/', '').trim();
        continue;
    }

    if (line.startsWith('@@')) {
        const match = line.match(/\+(\d+)/);
        lineNumber = match ? parseInt(match[1]) - 1 : 0;
        continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
        lineNumber++;

        const code = line.substring(1);

        for (const rule of rules) {
            if (rule.pattern.test(code)) {
                issues.push({
                    file: currentFile,
                    fileLine: lineNumber,
                    ruleId: rule.ruleId,
                    title: rule.title,
                    message: rule.description,
                    fix: rule.fix,
                    severity: rule.severity
                });
            }
        }
    }
}

// =======================
// GEMINI SUGGESTIONS
// =======================
async function runGemini() {
    if (!process.env.GEMINI_API_KEY) {
        console.log("⚠️ Gemini API key not found");
        fs.writeFileSync('new-suggestions.json', '[]');
        return;
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    });

    const prompt = `
Analyze this PR diff and suggest NEW code quality rules.

Return ONLY JSON array.

Fields:
id, name, description, severity, pattern

Diff:
${diff.substring(0, 8000)}
`;

    let suggestions = [];

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text();

        text = text.replace(/```json|```/g, '').trim();
        suggestions = JSON.parse(text);
    } catch (e) {
        console.log("❌ Gemini parse failed:", e.message);
        suggestions = [];
    }

    // =======================
    // REMOVE DUPLICATES
    // =======================
    const existingIds = new Set(rules.map(r => r.ruleId.toLowerCase()));

    const mapped = suggestions.map(s => ({
        ruleId: (s.id || '').toUpperCase(),
        title: s.name,
        description: s.description,
        severity: (s.severity || 'info').toLowerCase() === 'error'
            ? 'Error'
            : (s.severity || '').toLowerCase() === 'warning'
                ? 'Warning'
                : 'Info',
        pattern: s.pattern || ".*",
        fix: "Follow best practice"
    }));

    const newSuggestions = mapped.filter(r => {
        if (!r.ruleId) return false;

        const key = r.ruleId.toLowerCase();

        if (existingIds.has(key)) {
            console.log(`Skipping duplicate: ${r.ruleId}`);
            return false;
        }

        existingIds.add(key);
        return true;
    });

    fs.writeFileSync('new-suggestions.json', JSON.stringify(newSuggestions, null, 2));

    console.log(`✅ New suggestions: ${newSuggestions.length}`);
}

// =======================
// SAVE OUTPUT
// =======================
(async () => {
    await runGemini();

    fs.writeFileSync(outputFile, JSON.stringify(issues, null, 2));

    console.log(`✅ Issues found: ${issues.length}`);
})();