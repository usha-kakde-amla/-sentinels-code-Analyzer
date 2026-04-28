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
    // Your schema uses: RuleId, Title, Severity, Message, Fix, Detection
    const required = ['RuleId', 'Title', 'Severity', 'Message', 'Fix'];
    for (const field of required) {
        if (!rule[field]) {
            throw new Error(`Rule in ${sourceFile} is missing required field: "${field}"`);
        }
    }
    if (!['error', 'warning', 'info'].includes(rule.Severity.toLowerCase())) {
        throw new Error(`Rule "${rule.RuleId}" Severity must be Error|Warning|Info`);
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
1. A list of CUSTOM RULES defined by the team. Each rule has:
   - RuleId: unique rule identifier
   - Title: short label
   - Severity: Error | Warning | Info
   - Description: what the rule checks
   - Detection: list of patterns/scenarios that indicate a violation
   - Message: what to tell the developer
   - Fix: how to fix the violation
2. The added lines from a pull request diff (each prefixed with file name and line number).

YOUR ONLY JOB:
- Use the "Detection" hints in each rule to identify violations in the added lines.
- Report ONLY violations of the exact rules listed below.
- Do NOT suggest improvements, best practices, or any issues not covered by the rules.
- Do NOT add commentary, explanations, or extra fields.
- Do NOT invent new RuleIds or issues not in the rules list.
- If a line does not violate any rule, ignore it completely.

OUTPUT FORMAT:
Return ONLY a valid JSON array. No markdown, no code fences, no extra text — just the raw JSON array.
If there are no violations, return an empty array: []

Each violation object must have EXACTLY these fields (copy values directly from the matching rule):
{
  "ruleId":   "<RuleId from the matching rule>",
  "title":    "<Title from the matching rule>",
  "severity": "<Severity from the matching rule>",
  "message":  "<Message from the matching rule>",
  "fix":      "<Fix from the matching rule>",
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
async function callGemini(prompt, temperature = 0, systemText = null) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            temperature,
            responseMimeType: 'application/json',
        },
    };

    if (systemText) {
        body.systemInstruction = { parts: [{ text: systemText }] };
    }

    console.log(`🤖 Calling Gemini (${MODEL}) temperature=${temperature}...`);

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
    const validIds = new Set(rules.map(r => r.RuleId));
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

// ── Build free-form suggestion prompt ────────────────────────────────────────
// Second Gemini call: no rules given — Gemini reviews freely and suggests
// improvements. These will be compared against existing rules before approval.
function buildSuggestionPrompt(addedLines) {
    const diffText = addedLines
        .map(l => `[FILE: ${l.file}] [LINE: ${l.fileLine}] ${l.content}`)
        .join('\n');

    return `You are an expert code reviewer. Analyze the following pull request diff and suggest new code quality, security, or performance rules that are NOT already common — focus on patterns specific to this codebase.

For each suggestion, return it as a JSON object using this EXACT schema:
{
  "RuleId":      "SUGGESTED_<CATEGORY>_<3-digit number>",
  "Title":       "Short rule title",
  "Description": "What this rule checks and why it matters",
  "Severity":    "Error | Warning | Info",
  "Detection":   ["pattern or scenario that triggers this rule"],
  "Message":     "Message shown to developer when violated",
  "Fix":         "How to fix the violation"
}

Return ONLY a raw JSON array of suggestion objects. No markdown, no code fences, no extra text.
If you have no suggestions, return: []

PULL REQUEST DIFF:
${diffText}`;
}

// ── Deduplicate suggestions against existing rules ────────────────────────────
// Compares by RuleId prefix and title keywords to catch near-duplicates.
function deduplicateSuggestions(suggestions, existingRules) {
    const existingIds = new Set(existingRules.map(r => r.RuleId.toUpperCase()));
    const existingTitles = existingRules.map(r => r.Title.toLowerCase());

    const newSuggestions = [];

    for (const s of suggestions) {
        // Check exact RuleId match
        if (existingIds.has(s.RuleId.toUpperCase())) {
            console.log(`⏭️  Skipping duplicate RuleId: ${s.RuleId}`);
            continue;
        }

        // Check title similarity — if 3+ words overlap with an existing rule title, skip
        const sWords = new Set(s.Title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
        const isDuplicate = existingTitles.some(existingTitle => {
            const eWords = existingTitle.split(/\W+/).filter(w => w.length > 3);
            const overlap = eWords.filter(w => sWords.has(w)).length;
            return overlap >= 3;
        });

        if (isDuplicate) {
            console.log(`⏭️  Skipping near-duplicate title: "${s.Title}"`);
            continue;
        }

        newSuggestions.push(s);
    }

    console.log(`💡 New suggestions after deduplication: ${newSuggestions.length} / ${suggestions.length}`);
    return newSuggestions;
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
        fs.writeFileSync('new-suggestions.json', '[]', 'utf8');
        return;
    }

    // ── PASS 1: Enforce existing custom rules ──────────────────────────────────
    console.log('\n── Pass 1: Enforcing existing custom rules ──');
    const rulesPrompt = buildPrompt(rules, filteredLines);
    const rawIssues = await callGemini(
        rulesPrompt,
        0,
        'You are a strict code rule enforcement engine. Return ONLY a raw JSON array of violations. No prose, no markdown.'
    );
    const issues = sanitizeIssues(rawIssues, rules);

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(issues, null, 2), 'utf8');

    const counts = { error: 0, warning: 0, info: 0 };
    for (const i of issues) {
        const sev = i.severity.toLowerCase();
        counts[sev] = (counts[sev] || 0) + 1;
    }
    console.log(`\n📊 Rule violations:`);
    console.log(`   🔴 Errors:   ${counts.error}`);
    console.log(`   🟡 Warnings: ${counts.warning}`);
    console.log(`   🔵 Info:     ${counts.info}`);
    console.log(`\n✅ report.json written`);

    // ── PASS 2: Ask Gemini for new suggestions ─────────────────────────────────
    console.log('\n── Pass 2: Asking Gemini for new rule suggestions ──');
    const suggestionPrompt = buildSuggestionPrompt(filteredLines);

    let rawSuggestions = [];
    try {
        rawSuggestions = await callGemini(
            suggestionPrompt,
            0.4,  // higher temperature = more creative suggestions
            'You are an expert code reviewer. Suggest NEW rules as a raw JSON array only. No markdown, no prose, no code fences.'
        );
        console.log(`💡 Gemini returned ${rawSuggestions.length} suggestion(s)`);
    } catch (err) {
        console.error('❌ Pass 2 Gemini call failed:', err.message);
        fs.writeFileSync('new-suggestions.json', '[]', 'utf8');
        return;
    }

    if (!Array.isArray(rawSuggestions) || rawSuggestions.length === 0) {
        console.log('💡 No new suggestions from Gemini.');
        fs.writeFileSync('new-suggestions.json', '[]', 'utf8');
        return;
    }

    // Debug: log suggestion RuleIds
    console.log('💡 Suggestions received:', rawSuggestions.map(s => s.RuleId || s.Title).join(', '));

    // ── PASS 3: Filter out duplicates of existing rules ────────────────────────
    console.log('\n── Pass 3: Deduplicating against existing rules ──');
    const newSuggestions = deduplicateSuggestions(rawSuggestions, rules);

    fs.writeFileSync('new-suggestions.json', JSON.stringify(newSuggestions, null, 2), 'utf8');
    console.log(`\n✅ new-suggestions.json written (${newSuggestions.length} new rule(s) pending approval)`);
})();