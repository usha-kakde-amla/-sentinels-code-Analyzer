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

*

* NEW: --suggest-rules <file>

*   Gemini also looks for patterns NOT covered by existing rules and writes

*   them to <file>. The CI workflow then emails an approver; on approval

*   the rule is auto-committed to the rules/ folder.

*/

const fs = require('fs');

const path = require('path');

const args = require('minimist')(process.argv.slice(2));

// ── CLI args ─────────────────────────────────────────────────────────────────

const DIFF_FILE = args.diff || 'pr.diff';

const OUTPUT_FILE = args.output || 'report.json';

const RULES_DIR = args.rules || path.join(__dirname, 'rules');

const SUGGEST_RULES_FILE = args['suggest-rules'] || null;   // NEW

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const API_KEY = process.env.GEMINI_API_KEY;

// Chunk size — how many added lines to send per Gemini call.
// Keeps prompts within Gemini token limits on large PRs.
const CHUNK_SIZE = 300;

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

// ── Filter added lines by rule's filePattern ──────────────────────────────────

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

// ── Split lines into chunks ───────────────────────────────────────────────────

function chunkLines(lines, size) {

    const chunks = [];

    for (let i = 0; i < lines.length; i += size) {

        chunks.push(lines.slice(i, i + size));

    }

    return chunks;

}

// ── Build Gemini prompt ───────────────────────────────────────────────────────

function buildPrompt(rules, addedLines, includeSuggestions) {

    const rulesJson = JSON.stringify(rules, null, 2);

    const diffText = addedLines

        .map(l => `[FILE: ${l.file}] [LINE: ${l.fileLine}] ${l.content}`)

        .join('\n');

    // NEW: suggestion block appended only when --suggest-rules flag is passed

    const suggestionBlock = includeSuggestions ? `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RULE SUGGESTION TASK (Part 2):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After identifying violations, also look at the diff holistically.

If you spot recurring anti-patterns, architectural smells, or best-practice gaps

that are NOT covered by any of the existing rules above, suggest them as new rules.

Add a "suggestedRules" array to your JSON response object.

Each item must follow this exact schema:

{

  "RuleId":      "SUGGESTED-<UPPERCASE-SLUG>",

  "Title":       "Short human-readable title",

  "Description": "Why this pattern is problematic and when to flag it",

  "Severity":    "error | warning | info",

  "Detection":   ["pattern or scenario 1", "pattern or scenario 2"],

  "Message":     "What to tell the developer",

  "Fix":         "How a developer should fix or avoid this pattern",

  "example":     "The specific code snippet from this PR that inspired the rule",

  "tags":        ["tag1", "tag2"]

}

Return "suggestedRules": [] if no new rules are warranted.

IMPORTANT: Because you are now returning both violations AND suggestions,

change your output format to a JSON OBJECT (not a plain array):

{

  "violations": [ ...violation objects... ],

  "suggestedRules": [ ...suggested rule objects... ]

}

` : '';

    const outputFormatNote = includeSuggestions

        ? 'Return ONLY a valid JSON OBJECT with keys "violations" and "suggestedRules". No markdown, no code fences, no extra text.'

        : 'Return ONLY a valid JSON array. No markdown, no code fences, no extra text — just the raw JSON array.\nIf there are no violations, return an empty array: []';

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

YOUR ONLY JOB (Part 1 — Violations):

- Use the "Detection" hints in each rule to identify violations in the added lines.

- Report ONLY violations of the exact rules listed below.

- Do NOT suggest improvements, best practices, or any issues not covered by the rules.

- Do NOT add commentary, explanations, or extra fields.

- Do NOT invent new RuleIds or issues not in the rules list.

- If a line does not violate any rule, ignore it completely.

OUTPUT FORMAT:

${outputFormatNote}

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

${suggestionBlock}

Remember: ${includeSuggestions ? 'Return ONLY the raw JSON object with "violations" and "suggestedRules" keys. No extra text.' : 'Return ONLY the raw JSON array. No extra text. No suggestions outside the rules above.'}`;

}

// ── Call Gemini API ───────────────────────────────────────────────────────────

async function callGemini(prompt, includeSuggestions) {

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    const body = {

        contents: [{ parts: [{ text: prompt }] }],

        generationConfig: {

            temperature: 0,

            topP: 1,

            topK: 1,

            responseMimeType: 'application/json',

            // FIX: raise output token limit so Gemini never truncates suggestions
            maxOutputTokens: 8192,

        },

        // FIX: system instruction now matches the task — no longer contradicts suggestion mode
        systemInstruction: {

            parts: [{

                text: includeSuggestions
                    ? 'You are a code review enforcement engine. You report violations of the exact rules you are given AND suggest new rules for uncovered patterns. You ALWAYS return raw JSON only — no markdown, no prose, no code fences.'
                    : 'You are a code rule enforcement engine. You ONLY report violations of the exact rules you are given. You NEVER invent new rules, suggest improvements, or add any output beyond what the rules specify. You ALWAYS return a raw JSON array only — no markdown, no prose, no code fences.'

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

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    try {

        const parsed = JSON.parse(cleaned);

        return parsed;

    } catch (e) {

        console.error('❌ Failed to parse Gemini response as JSON:\n', cleaned.slice(0, 500));

        throw e;

    }

}

// ── Sanitize violations against the known rule set ────────────────────────────

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

// ── Write suggested rules to file (merge, not overwrite) ─────────────────────

function writeSuggestedRules(suggested, outputPath) {

    if (!outputPath) return;

    const valid = (suggested || []).filter(r => r.RuleId && r.Title && r.Severity);

    // FIX: read existing file content and merge, instead of overwriting.
    // This ensures suggestions from earlier chunks are never lost.
    let existing = [];

    if (fs.existsSync(outputPath)) {

        try {

            const raw = fs.readFileSync(outputPath, 'utf8').trim();

            if (raw && raw !== '[]') existing = JSON.parse(raw);

        } catch (e) {

            console.warn(`⚠️  Could not read existing ${outputPath} — starting fresh`);

        }

    }

    const merged = [...existing, ...valid];

    // Deduplicate by RuleId
    const seen = new Set();

    const deduped = merged.filter(r => {

        if (seen.has(r.RuleId)) return false;

        seen.add(r.RuleId);

        return true;

    });

    if (deduped.length === 0) {

        console.log('ℹ️  Gemini found no new rule suggestions.');

    } else {

        console.log(`💡 Gemini suggested ${deduped.length} new rule(s) — writing to ${outputPath}`);

    }

    fs.writeFileSync(outputPath, JSON.stringify(deduped, null, 2) + '\n', 'utf8');

}

// ── Main ──────────────────────────────────────────────────────────────────────

(async function main() {

    console.log('🛡️  Sentinels Gemini-Enforced Rule Analyzer starting...\n');

    const rules = loadRules(RULES_DIR);

    if (rules.length === 0) {

        console.log('No rules found — writing empty report.');

        fs.writeFileSync(OUTPUT_FILE, '[]', 'utf8');

        if (SUGGEST_RULES_FILE) fs.writeFileSync(SUGGEST_RULES_FILE, '[]\n', 'utf8');

        return;

    }

    const addedLines = parseDiff(DIFF_FILE);

    const filteredLines = preFilterLines(addedLines, rules);

    if (filteredLines.length === 0) {

        console.log('No relevant added lines to analyze — writing empty report.');

        fs.writeFileSync(OUTPUT_FILE, '[]', 'utf8');

        if (SUGGEST_RULES_FILE) fs.writeFileSync(SUGGEST_RULES_FILE, '[]\n', 'utf8');

        return;

    }

    // Split lines into chunks so large PRs never exceed Gemini token limits
    const chunks = chunkLines(filteredLines, CHUNK_SIZE);

    console.log(`📦 Split ${filteredLines.length} lines into ${chunks.length} chunk(s) of max ${CHUNK_SIZE} lines each\n`);

    // Reset suggested-rules file clean before processing first chunk
    if (SUGGEST_RULES_FILE) {

        fs.writeFileSync(SUGGEST_RULES_FILE, '[]\n', 'utf8');

    }

    const allIssues = [];

    for (let i = 0; i < chunks.length; i++) {

        console.log(`\n🔄 Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} lines)...`);

        // Pass includeSuggestions=true only when --suggest-rules flag is set

        const prompt = buildPrompt(rules, chunks[i], !!SUGGEST_RULES_FILE);

        const geminiResult = await callGemini(prompt, !!SUGGEST_RULES_FILE);

        // ── Handle both response shapes ───────────────────────────────────────────

        // Without --suggest-rules  → Gemini returns a plain array  (old behaviour)

        // With    --suggest-rules  → Gemini returns { violations, suggestedRules }

        let rawIssues;

        let suggestedRules = [];

        if (Array.isArray(geminiResult)) {

            // Old shape — plain violations array

            rawIssues = geminiResult;

        } else if (geminiResult && typeof geminiResult === 'object') {

            // New shape — object with violations + suggestedRules

            rawIssues = Array.isArray(geminiResult.violations) ? geminiResult.violations : [];

            suggestedRules = Array.isArray(geminiResult.suggestedRules) ? geminiResult.suggestedRules : [];

        } else {

            console.warn('⚠️  Unexpected Gemini response shape — treating as empty');

            rawIssues = [];

        }

        // Sanitize violations (existing behaviour — unchanged)

        const sanitized = sanitizeIssues(rawIssues, rules);

        allIssues.push(...sanitized);

        console.log(`   ✅ Chunk ${i + 1}: ${sanitized.length} violation(s), ${suggestedRules.length} suggestion(s)`);

        // NEW: write suggested rules when flag is present (merges with previous chunks)

        if (SUGGEST_RULES_FILE) {

            writeSuggestedRules(suggestedRules, SUGGEST_RULES_FILE);

        }

    }

    // Write violations report (existing behaviour — unchanged)

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allIssues, null, 2), 'utf8');

    // ── Summary ───────────────────────────────────────────────────────────────

    const counts = { error: 0, warning: 0, info: 0 };

    for (const i of allIssues) {

        const sev = i.severity.toLowerCase();

        counts[sev] = (counts[sev] || 0) + 1;

    }

    // Read final suggested rules count for summary
    let finalSuggestionsCount = 0;

    if (SUGGEST_RULES_FILE && fs.existsSync(SUGGEST_RULES_FILE)) {

        try { finalSuggestionsCount = JSON.parse(fs.readFileSync(SUGGEST_RULES_FILE, 'utf8')).length; } catch (_) { }

    }

    console.log(`\n📊 Results:`);

    console.log(`   🔴 Errors:   ${counts.error}`);

    console.log(`   🟡 Warnings: ${counts.warning}`);

    console.log(`   🔵 Info:     ${counts.info}`);

    console.log(`   Total:       ${allIssues.length}`);

    if (SUGGEST_RULES_FILE) {

        console.log(`   💡 New rule suggestions: ${finalSuggestionsCount}`);

    }

    console.log(`\n✅ Report written to ${OUTPUT_FILE}`);

    if (SUGGEST_RULES_FILE) {

        console.log(`✅ Suggested rules written to ${SUGGEST_RULES_FILE}`);

    }

})();
