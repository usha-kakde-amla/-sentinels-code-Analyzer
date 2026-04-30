#!/usr/bin/env node
/**
 * pr-analyzer.js
 *
 * Pass 1 — Enforce your existing Sentinels rules against the PR diff.
 *           Rules use PascalCase fields: RuleId, Title, Description,
 *           Severity, Detection (array of patterns), Message, Fix.
 *
 * Pass 2 — Ask Gemini to suggest NEW rules based on the same diff.
 *
 * Pass 3 — Deduplicate suggestions against every rule already loaded.
 *
 * Outputs:
 *   report.json          – violations array, used by workflow to post PR comments
 *   new-suggestions.json – deduplicated new rule suggestions, sent for approval
 */

'use strict';

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = minimist(process.argv.slice(2));
const diffFile = args.diff || 'pr.diff';
const rulesPath = args.rules || './rules';
const outFile = args.output || 'report.json';

if (!process.env.GEMINI_API_KEY) {
    console.error('❌  GEMINI_API_KEY is not set');
    process.exit(1);
}

if (!fs.existsSync(diffFile)) {
    console.error(`❌  Diff file not found: ${diffFile}`);
    process.exit(1);
}

const diff = fs.readFileSync(diffFile, 'utf8').trim();
if (!diff) {
    console.log('ℹ️  Empty diff — nothing to analyse.');
    fs.writeFileSync(outFile, '[]');
    fs.writeFileSync('new-suggestions.json', '[]');
    process.exit(0);
}

// ── Load existing rules ───────────────────────────────────────────────────────
// Your rules use PascalCase: RuleId, Title, Description, Severity,
// Detection (string or string[]), Message, Fix
function loadRules(folderPath) {
    if (!fs.existsSync(folderPath)) return [];
    const all = [];
    for (const file of fs.readdirSync(folderPath)) {
        if (!file.endsWith('.json')) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(folderPath, file), 'utf8'));
            all.push(...(Array.isArray(raw) ? raw : [raw]));
        } catch (e) {
            console.warn(`⚠️  Could not parse ${file}: ${e.message}`);
        }
    }
    return all;
}

const existingRules = loadRules(rulesPath);
console.log(`📚  Loaded ${existingRules.length} existing rules from ${rulesPath}`);

// ── Gemini setup ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function clean(text) {
    return text
        .replace(/^```json\s*/im, '')
        .replace(/^```\s*/im, '')
        .replace(/\s*```$/im, '')
        .trim();
}

function safeParseArray(text, label) {
    try {
        const parsed = JSON.parse(clean(text));
        if (Array.isArray(parsed)) return parsed;
        console.warn(`⚠️  ${label}: expected JSON array, got ${typeof parsed}`);
        return [];
    } catch (e) {
        console.warn(`⚠️  ${label}: JSON parse failed — ${e.message}`);
        console.warn('    Raw (first 500 chars):', text.slice(0, 500));
        return [];
    }
}

// Deduplication — handles both camelCase and PascalCase fields
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with',
    'is', 'are', 'be', 'use', 'avoid', 'do', 'not', 'no', 'should', 'must',
]);
function words(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function isDuplicate(suggestion) {
    const sugId = (suggestion.RuleId || suggestion.ruleId || '').toLowerCase();
    const sugTitle = (suggestion.Title || suggestion.title || '').toLowerCase();
    const sugWords = words(sugTitle);

    return existingRules.some(r => {
        const rId = (r.RuleId || r.ruleId || '').toLowerCase();
        const rTitle = (r.Title || r.title || '').toLowerCase();
        if (sugId && rId && sugId === rId) return true;
        if (sugTitle && rTitle && sugTitle === rTitle) return true;
        if (sugWords.length >= 3) {
            const shared = sugWords.filter(w => words(rTitle).includes(w));
            if (shared.length >= 3) return true;
        }
        return false;
    });
}

// ── PASS 1 PROMPT ─────────────────────────────────────────────────────────────
// KEY FIX: We explicitly explain the Detection field, instruct Gemini to use it
// for matching, and tell it to output the EXACT RuleId/Title from the rules.
function buildAnalysisPrompt(diff, rules) {
    return `You are a strict code-analysis engine enforcing a custom ruleset.

RULES SCHEMA — each rule object has these fields:
  RuleId      – unique rule identifier, e.g. "SEC001", "TS_SEC001", "TSQL001"
  Title       – short name for the rule
  Description – what the rule is about
  Severity    – "Error", "Warning", "Info", "MAJOR", "MINOR"
  Detection   – one or more strings describing code patterns that trigger this rule.
                This is the MOST IMPORTANT field. Match added lines in the diff
                against these Detection strings to find violations.
  Message     – message to show the developer
  Fix         – how to fix the violation

YOUR TASK:
1. Read the CODE DIFF below.
2. Focus on lines that start with "+" (these are newly added lines).
3. For each added line, check whether it matches the Detection patterns of any rule.
4. If it does, report a violation using that rule's RuleId and Title exactly as given.
5. Do NOT invent rules. Do NOT flag lines that do not actually match any Detection pattern.
6. Return a JSON array only — no markdown, no explanation, no extra text.
7. If there are no violations, return exactly: []

RULES TO ENFORCE:
${JSON.stringify(rules, null, 2)}

CODE DIFF:
${diff}

OUTPUT FORMAT — use exact RuleId and Title from the rules above, severity in lowercase:
[
  {
    "file":     "relative/path/to/file.ext",
    "fileLine": 42,
    "ruleId":   "SEC001",
    "title":    "Avoid Hardcoded Credentials",
    "message":  "Specific description of what is wrong on this line",
    "fix":      "How to fix this specific instance",
    "severity": "error"
  }
]`;
}

// ── PASS 2 PROMPT ─────────────────────────────────────────────────────────────
function buildSuggestionPrompt(diff, existingRules) {
    const summary = existingRules.map(r => ({
        RuleId: r.RuleId || r.ruleId,
        Title: r.Title || r.title,
    }));

    return `You are a senior software quality engineer reviewing a pull-request diff.

TASK:
Suggest NEW static-analysis rules that would catch potential issues or anti-patterns
visible in this diff, beyond what is already covered by existing rules.

CONSTRAINTS:
- Do NOT duplicate any rule from the EXISTING RULES list below (matched by RuleId or Title).
- Each rule must be generic and reusable — not tied to this specific PR.
- Return a JSON array only. No markdown, no explanation, no extra text.
- If you have no meaningful new rules to suggest, return exactly: []

EXISTING RULES (do not duplicate these):
${JSON.stringify(summary, null, 2)}

CODE DIFF:
${diff}

OUTPUT FORMAT (JSON array — use PascalCase field names to match existing rules):
[
  {
    "RuleId":      "AUTO_001",
    "Title":       "Short descriptive title",
    "Description": "Why this pattern is problematic",
    "Severity":    "Error | Warning | Info",
    "Detection":   ["pattern or code construct that triggers this rule"],
    "Message":     "What to tell the developer",
    "Fix":         "How to fix violations of this rule",
    "Category":    "Security | Performance | Maintainability | Reliability | Style"
  }
]`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    try {
        // ── PASS 1: Enforce existing rules ────────────────────────────────────
        console.log('\n🔍  Pass 1 — Enforcing existing Sentinels rules against PR diff …');
        let violations = [];
        try {
            const res = await model.generateContent(buildAnalysisPrompt(diff, existingRules));
            violations = safeParseArray(res.response.text(), 'Pass 1 (violations)');
        } catch (e) {
            console.warn(`⚠️  Pass 1 Gemini API error: ${e.message}`);
        }

        fs.writeFileSync(outFile, JSON.stringify(violations, null, 2));
        console.log(`✅  report.json written — ${violations.length} violation(s)`);

        if (violations.length > 0) {
            console.log('\n    Violations:');
            violations.forEach(v =>
                console.log(`    🔴 [${v.ruleId}] ${v.title} — ${v.file}:${v.fileLine}`)
            );
        }

        // ── PASS 2: Generate new rule suggestions ─────────────────────────────
        console.log('\n🤖  Pass 2 — Asking Gemini to suggest new rules …');
        let suggestions = [];
        try {
            const res = await model.generateContent(buildSuggestionPrompt(diff, existingRules));
            suggestions = safeParseArray(res.response.text(), 'Pass 2 (suggestions)');
            console.log(`    Gemini suggested ${suggestions.length} rule(s) before deduplication`);
        } catch (e) {
            console.warn(`⚠️  Pass 2 Gemini API error: ${e.message}`);
        }

        // ── PASS 3: Deduplicate ────────────────────────────────────────────────
        console.log('\n🔎  Pass 3 — Deduplicating against existing rules …');
        const newRules = [];
        for (const s of suggestions) {
            const label = s.RuleId || s.ruleId || s.Title || s.title || '(unnamed)';
            if (isDuplicate(s)) {
                console.log(`    ↩️  Skipped duplicate: ${label}`);
            } else {
                console.log(`    ✅  New rule kept:     ${label}`);
                newRules.push(s);
            }
        }

        fs.writeFileSync('new-suggestions.json', JSON.stringify(newRules, null, 2));
        console.log(`\n🆕  new-suggestions.json written — ${newRules.length} new rule(s) ready for approval`);

    } catch (err) {
        console.error('\n❌  Fatal error:', err.message);
        process.exit(1);
    }
})();