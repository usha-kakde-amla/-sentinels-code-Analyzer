#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const args = minimist(process.argv.slice(2));

const diffFile = args.diff || 'pr.diff';
const rulesPath = args.rules || './rules';
const outputFile = args.output || 'report.json';

if (!process.env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY missing');
    process.exit(1);
}

const diff = fs.readFileSync(diffFile, 'utf8');

// --------------------
// LOAD RULES
// --------------------
function loadRules(folderPath) {
    const files = fs.readdirSync(folderPath);
    let allRules = [];

    files.forEach(file => {
        if (file.endsWith('.json')) {
            const content = JSON.parse(
                fs.readFileSync(path.join(folderPath, file), 'utf8')
            );
            if (Array.isArray(content)) allRules.push(...content);
            else allRules.push(content);
        }
    });

    return allRules;
}

const rules = loadRules(rulesPath);

// --------------------
// GEMINI SETUP
// --------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
});

// --------------------
// HELPERS
// --------------------
function clean(text) {
    return text.replace(/```json/g, '').replace(/```/g, '').trim();
}

function isDuplicate(newRule, existingRules) {
    return existingRules.some(r =>
        r.ruleId === newRule.ruleId ||
        (r.title && newRule.title &&
            r.title.toLowerCase() === newRule.title.toLowerCase())
    );
}

// --------------------
// PROMPTS
// --------------------
function analysisPrompt(diff, rules) {
    return `
STRICT RULE ENGINE:
- Use ONLY given rules
- No extra suggestions
- Return JSON only

RULES:
${JSON.stringify(rules, null, 2)}

CODE DIFF:
${diff}

OUTPUT:
[
  {
    "file": "string",
    "fileLine": number,
    "ruleId": "string",
    "title": "string",
    "message": "string",
    "fix": "string",
    "severity": "error|warning|info"
  }
]
`;
}

function suggestionPrompt(diff) {
    return `
Generate NEW reusable static analysis rules.

- No duplicates
- JSON only

FORMAT:
[
  {
    "ruleId": "AUTO_001",
    "title": "Short title",
    "description": "Description",
    "pattern": "regex",
    "severity": "Error|Warning|Info",
    "message": "Problem",
    "fix": "Fix"
  }
]

CODE DIFF:
${diff}
`;
}

// --------------------
// MAIN
// --------------------
(async () => {
    try {
        console.log("🔍 Running analysis...");

        // RULE ANALYSIS
        let report = [];
        try {
            const res = await model.generateContent(
                analysisPrompt(diff, rules)
            );
            report = JSON.parse(clean(res.response.text()));
        } catch {
            console.log("⚠️ Invalid analysis JSON");
        }

        fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
        console.log(`✅ Violations: ${report.length}`);

        // GEMINI SUGGESTIONS
        console.log("🤖 Generating suggestions...");
        let suggestions = [];

        try {
            const res = await model.generateContent(
                suggestionPrompt(diff)
            );
            suggestions = JSON.parse(clean(res.response.text()));
        } catch {
            console.log("⚠️ Invalid suggestions JSON");
        }

        // FILTER DUPLICATES
        const newRules = suggestions.filter(r => !isDuplicate(r, rules));

        fs.writeFileSync(
            'new-suggestions.json',
            JSON.stringify(newRules, null, 2)
        );

        console.log(`🆕 New rules: ${newRules.length}`);

    } catch (err) {
        console.error("❌ Error:", err.message);
        process.exit(1);
    }
})();