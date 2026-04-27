#!/usr/bin/env node
/**
 * Sentinels PR Analyzer — Gemini-Enforced Custom Rules
 *
 * Sends your custom rules + PR diff to Gemini and instructs it to ONLY
 * report violations of those exact rules. No free-form AI suggestions.
 *
 * Rule JSON schema (each file = one rule or array of rules):
 * {
 *   "id": "NO_CONSOLE_LOG",
 *   "title": "No console.log in production code",
 *   "severity": "error" | "warning" | "info",
 *   "message": "console.log should not be committed.",
 *   "fix": "Remove or replace with a proper logger.",
 *   "filePattern": "\\.js$"   // optional: only apply to matching filenames
 * }
 *
 * Gemini is told: look at the diff, apply only these rules, return JSON.
 * It is explicitly forbidden from inventing new issues outside the rules.
 */

const fs = require('fs');
const path = require('path');
const args = require('minimist')(process.argv.slice(2));

// ── CLI args ─────────────────────────────────────────────────────────────────
const DIFF_FILE = args.diff || 'pr.diff';
const OUTPUT_FILE = args.output || 'report.json';
const RULES_DIR = args.rules || path.join(__dirname, 'rules');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error('❌ GEMINI_API_KEY environment variable is not set.');
    process.exit(1);
}

// ── Load rules from rules/ folder ────────────────────────────────────────────
function loadRules(rulesDir) {
    if (!fs.existsSync(rulesDir)) {
        console.error(`❌ Rules directory not found: ${rulesDir}`);
        process.exit(1);
    }

    const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));

    if (files.length === 0) {
        console.warn(`⚠️  No JSON rule files found in: ${rulesDir}`);
        return [];
    }

    const rules = [];
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(rulesDir, file), 'utf8');
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : [parsed];
            for (const rule of list) {
                validateRule(rule, file);
                rules.push(rule);
            }
            console.log(`✅ Loaded ${list.length} rule(s) from ${file}`);
        } catch (err) {
            console.error(`❌ Failed to load ${file}: ${err.message}`);
        }
    }

    console.log(`📋 Total rules loaded: ${rules.length}`);
    return rules;
}

function validateRule(rule, sourceFile) {
    const required = ['id', 'title', 'severity', 'message', 'fix'];
    for (const field of required) {
        if (!rule[field]) {
            throw new Error(`Rule in ${sourceFile} is missing required field: "${field}"`);
        }
    }
    if (!['error', 'warning', 'info'].includes(rule.severity.toLowerCase())) {
        throw new Error(`Rule "${rule.id}" severity must be error|warning|info`);
    }
}

// ── Parse diff to extract added lines with metadata ───────────────────────────
// Returns: [{ file, fileLine, content }]
function parseDiff(diffPath) {
    if (!fs.existsSync(diffPath)) {
        console.error(`❌ Diff file not found: ${diffPath}`);
        process.exit(1);
    }

    const lines = fs.readFileSync(diffPath, 'utf8').split('\n');
    const added = [];
    let curFile = null;
    let fileLine = 0;

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = line.match(/b\/(.+)$/);
            curFile = match ? match[1] : null;
            fileLine = 0;
            continue;
        }
        if (line.startsWith('@@')) {
            const match = line.match(/\+(\d+)/);
            fileLine = match ? parseInt(match[1], 10) - 1 : 0;
            continue;
        }
        if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;

        if (line.startsWith('+')) {
            fileLine++;
            if (curFile) added.push({ file: curFile, fileLine, content: line.slice(1) });
        } else if (!line.startsWith('-')) {
            fileLine++;
        }
    }

    console.log(`🔍 Parsed ${added.length} added line(s) from diff`);
    return added;
}

// ── Filter added lines by rule's filePattern (pre-filter before Gemini) ──────
function preFilterLines(addedLines, rules) {
    const relevant = new Set();
    for (const { file } of addedLines) {
        for (const rule of rules) {
            if (!rule.filePattern || new RegExp(rule.filePattern).test(file)) {
                relevant.add(file);
                break;
            }
        }
    }
    return addedLines.filter(l => relevant.has(l.file));
}

// ── Build the strict Gemini prompt ───────────────────────────────────────────
function buildPrompt(rules, addedLines) {
    const rulesJson = JSON.stringify(rules, null, 2);

    const diffText = addedLines
        .map(l => `[FILE: ${l.file}] [LINE: ${l.fileLine}] ${l.content}`)
        .join('\n');

    return `You are a strict code review enforcement engine.

You will be given:
1. A list of CUSTOM RULES defined by the team.
2. The added lines from a pull request diff (each line prefixed with its file name and line number).

YOUR ONLY JOB:
- Check each added line against the provided custom rules.
- Report ONLY violations of the exact rules listed below.
- Do NOT suggest improvements, best practices, or any issues not covered by the rules.
- Do NOT add commentary, explanations, or extra fields beyond what is specified.
- Do NOT invent new rule IDs or issues that are not in the rules list.
- If a line does not violate any rule, ignore it completely.

OUTPUT FORMAT:
Return ONLY a valid JSON array. No markdown, no code fences, no extra text — just the raw JSON array.
If there are no violations, return an empty array: []

Each violation object must have EXACTLY these fields (copy the values directly from the matching rule):
{
  "ruleId":   "<id from the matching rule>",
  "title":    "<title from the matching rule>",
  "severity": "<severity from the matching rule>",
  "message":  "<message from the matching rule>",
  "fix":      "<fix from the matching rule>",
  "file":     "<filename from the diff line>",
  "fileLine": <line number as integer from the diff line>
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUSTOM RULES (enforce ONLY these — do not go beyond them):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${rulesJson}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PULL REQUEST DIFF (added lines only):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${diffText}

Remember: Return ONLY the raw JSON array. No extra text. No suggestions outside the rules above.`;
}

// ── Call Gemini API ───────────────────────────────────────────────────────────
async function callGemini(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature: 0,     // deterministic — no creative additions
            topP: 1,
            topK: 1,
            responseMimeType: 'application/json',  // force JSON output mode
        },
        systemInstruction: {
            parts: [{
                text: 'You are a code rule enforcement engine. You ONLY report violations of the exact rules you are given. You NEVER invent new rules, suggest improvements, or add any output beyond what the rules specify. You ALWAYS return a raw JSON array only — no markdown, no prose, no code fences.'
            }]
        }
    };

    console.log(`🤖 Calling Gemini (${MODEL})...`);

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${err}`);
    }

    const data = await res.json();

    // Extract text from Gemini response structure
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    // Strip any markdown fences Gemini may add despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    try {
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) {
            console.warn('⚠️  Gemini returned non-array JSON — treating as empty');
            return [];
        }
        return parsed;
    } catch (e) {
        console.error('❌ Failed to parse Gemini response as JSON:\n', cleaned.slice(0, 500));
        throw e;
    }
}

// ── Sanitize Gemini output against the known rule set ────────────────────────
// This is a safety net: discard any issue whose ruleId doesn't exist in your
// rules — prevents hallucinated violations from slipping through.
function sanitizeIssues(issues, rules) {
    const validIds = new Set(rules.map(r => r.id));
    const before = issues.length;

    const clean = issues.filter(issue => {
        if (!validIds.has(issue.ruleId)) {
            console.warn(`⚠️  Discarding hallucinated rule "${issue.ruleId}" — not in your rules`);
            return false;
        }
        return true;
    });

    if (clean.length < before) {
        console.log(`🧹 Removed ${before - clean.length} hallucinated issue(s)`);
    }

    return clean;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async function main() {
    console.log('🛡️  Sentinels Gemini-Enforced Rule Analyzer starting...\n');

    const rules = loadRules(RULES_DIR);
    if (rules.length === 0) {
        console.log('No rules found — writing empty report.');
        fs.writeFileSync(OUTPUT_FILE, '[]', 'utf8');
        return;
    }

    const addedLines = parseDiff(DIFF_FILE);
    const filteredLines = preFilterLines(addedLines, rules);

    if (filteredLines.length === 0) {
        console.log('No relevant added lines to analyze — writing empty report.');
        fs.writeFileSync(OUTPUT_FILE, '[]', 'utf8');
        return;
    }

    const prompt = buildPrompt(rules, filteredLines);
    const raw = await callGemini(prompt);
    const issues = sanitizeIssues(raw, rules);

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(issues, null, 2), 'utf8');

    const counts = { error: 0, warning: 0, info: 0 };
    for (const i of issues) {
        const sev = i.severity.toLowerCase();
        counts[sev] = (counts[sev] || 0) + 1;
    }

    console.log(`\n📊 Results:`);
    console.log(`   🔴 Errors:   ${counts.error}`);
    console.log(`   🟡 Warnings: ${counts.warning}`);
    console.log(`   🔵 Info:     ${counts.info}`);
    console.log(`   Total:       ${issues.length}`);
    console.log(`\n✅ Report written to ${OUTPUT_FILE}`);
})();