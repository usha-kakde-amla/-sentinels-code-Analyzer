#!/usr/bin/env node
/**
 * pr-analyzer.js  – Sentinels Code Analyzer (3-pass engine)
 *
 * Pass 1 → Enforce existing rules   → writes report.json
 * Pass 2 → Gemini suggests new rules
 * Pass 3 → Deduplicate vs existing  → writes new-suggestions.json
 *
 * Usage:
 *   node pr-analyzer.js --diff pr.diff --output report.json --rules ./rules
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const DIFF_FILE = get('--diff') || 'pr.diff';
const OUTPUT_FILE = get('--output') || 'report.json';
const RULES_DIR = get('--rules') || './rules';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadRules(rulesDir) {
    if (!fs.existsSync(rulesDir)) {
        console.warn(`[WARN] Rules directory not found: ${rulesDir}`);
        return [];
    }
    const rules = [];
    for (const file of fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'))) {
        try {
            const raw = fs.readFileSync(path.join(rulesDir, file), 'utf8');
            const data = JSON.parse(raw);
            const arr = Array.isArray(data) ? data : [data];
            arr.forEach(r => { r._sourceFile = file; });
            rules.push(...arr);
        } catch (e) {
            console.warn(`[WARN] Could not parse rule file ${file}: ${e.message}`);
        }
    }
    return rules;
}

function parseDiff(diffText) {
    /**
     * Returns an array of hunks:
     *   { file, hunk, addedLines: [{lineNo, content}], removedLines: [...], contextLines: [...] }
     */
    const hunks = [];
    let curFile = null;
    let curHunk = null;
    let lineNo = 0;

    for (const raw of diffText.split('\n')) {
        if (raw.startsWith('diff --git')) {
            curFile = null;
            curHunk = null;
            continue;
        }
        if (raw.startsWith('+++ b/')) {
            curFile = raw.slice(6).trim();
            continue;
        }
        if (raw.startsWith('--- ')) continue;

        if (raw.startsWith('@@')) {
            const m = raw.match(/\+(\d+)/);
            lineNo = m ? parseInt(m[1], 10) - 1 : 0;
            curHunk = { file: curFile, hunk: raw, addedLines: [], removedLines: [], contextLines: [] };
            hunks.push(curHunk);
            continue;
        }

        if (!curHunk) continue;

        if (raw.startsWith('+')) {
            lineNo++;
            curHunk.addedLines.push({ lineNo, content: raw.slice(1) });
        } else if (raw.startsWith('-')) {
            curHunk.removedLines.push({ lineNo, content: raw.slice(1) });
        } else {
            lineNo++;
            curHunk.contextLines.push({ lineNo, content: raw.slice(1) });
        }
    }
    return hunks;
}

// ─── Pass 1: enforce existing rules ──────────────────────────────────────────
function enforceRules(hunks, rules) {
    const violations = [];

    for (const hunk of hunks) {
        if (!hunk.file) continue;
        const ext = path.extname(hunk.file).toLowerCase();

        for (const rule of rules) {
            const ruleExt = rule.FileExtensions || rule.fileExtensions || [];
            // If rule scopes to specific extensions, skip non-matching files
            if (ruleExt.length > 0 && !ruleExt.includes(ext)) continue;

            const patterns = rule.Patterns || rule.patterns || [];

            for (const added of hunk.addedLines) {
                for (const pat of patterns) {
                    let matched = false;
                    try {
                        matched = new RegExp(pat, 'i').test(added.content);
                    } catch {
                        matched = added.content.includes(pat);
                    }

                    if (matched) {
                        violations.push({
                            ruleId: rule.RuleId || rule.ruleId || 'UNKNOWN',
                            title: rule.Title || rule.title || 'Unnamed Rule',
                            severity: rule.Severity || rule.severity || 'warning',
                            message: rule.Message || rule.message || 'Rule violation detected.',
                            fix: rule.Fix || rule.fix || '',
                            file: hunk.file,
                            fileLine: added.lineNo,
                            snippet: added.content.trim().slice(0, 200),
                        });
                    }
                }
            }
        }
    }
    return violations;
}

// ─── Pass 2: ask Gemini for new rule suggestions ──────────────────────────────
async function askGemini(diffText, existingRules) {
    if (!GEMINI_API_KEY) {
        console.log('[INFO] No GEMINI_API_KEY — skipping suggestion pass.');
        return [];
    }

    const existingSummary = existingRules.map(r =>
        `${r.RuleId || r.ruleId}: ${r.Title || r.title}`
    ).join('\n');

    const prompt = `
You are a senior code reviewer. Analyze the following git diff and suggest NEW coding rules that should be enforced to prevent similar issues in future PRs.

EXISTING RULES (do NOT suggest these again):
${existingSummary || '(none yet)'}

GIT DIFF:
\`\`\`
${diffText.slice(0, 12000)}
\`\`\`

Return ONLY a valid JSON array of rule objects. Each object must have:
- "RuleId":        unique ID like "RULE-XXX" (choose a number not in existing rules)
- "Title":         short rule name
- "Description":   what the rule prevents
- "Severity":      "error" | "warning" | "info"
- "Patterns":      array of regex strings to detect the violation
- "FileExtensions": array like [".js", ".ts"] or [] for all files
- "Message":       message shown to developer
- "Fix":           how to fix it
- "Category":      e.g. "security", "style", "performance", "correctness"

Return [] if no meaningful new rules can be suggested.
Return ONLY the JSON array — no markdown, no explanation.
`.trim();

    try {
        const { default: fetch } = await import('node-fetch');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
        };

        console.log(`[Pass 2] Calling Gemini (${GEMINI_MODEL})…`);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const err = await res.text();
            console.warn(`[WARN] Gemini API error ${res.status}: ${err.slice(0, 500)}`);
            return [];
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // Strip fences
        const clean = text.replace(/```json|```/g, '').trim();
        const suggestions = JSON.parse(clean);
        return Array.isArray(suggestions) ? suggestions : [];
    } catch (e) {
        console.warn(`[WARN] Gemini call failed: ${e.message}`);
        return [];
    }
}

// ─── Pass 3: deduplicate suggestions ──────────────────────────────────────────
function deduplicateSuggestions(suggestions, existingRules) {
    const existingIds = new Set(existingRules.map(r => (r.RuleId || r.ruleId || '').toLowerCase()));
    const existingTitles = new Set(existingRules.map(r => (r.Title || r.title || '').toLowerCase().trim()));

    return suggestions.filter(s => {
        const id = (s.RuleId || '').toLowerCase();
        const title = (s.Title || '').toLowerCase().trim();
        const dupId = existingIds.has(id);
        const dupTitle = existingTitles.has(title);
        if (dupId || dupTitle) {
            console.log(`[Pass 3] Skipping duplicate: ${s.RuleId} "${s.Title}"`);
            return false;
        }
        return true;
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    console.log('=== Sentinels Code Analyzer ===');
    console.log(`Diff:   ${DIFF_FILE}`);
    console.log(`Rules:  ${RULES_DIR}`);
    console.log(`Output: ${OUTPUT_FILE}`);

    // Read diff
    if (!fs.existsSync(DIFF_FILE)) {
        console.error(`[ERROR] Diff file not found: ${DIFF_FILE}`);
        fs.writeFileSync(OUTPUT_FILE, '[]');
        fs.writeFileSync('new-suggestions.json', '[]');
        process.exit(0);
    }
    const diffText = fs.readFileSync(DIFF_FILE, 'utf8');
    console.log(`Diff size: ${diffText.length} bytes`);

    // Load rules
    const rules = loadRules(RULES_DIR);
    console.log(`Loaded ${rules.length} rule(s) from ${RULES_DIR}`);

    // Parse diff into hunks
    const hunks = parseDiff(diffText);
    console.log(`Parsed ${hunks.length} hunk(s) across ${new Set(hunks.map(h => h.file)).size} file(s)`);

    // ── Pass 1 ────────────────────────────────────────────────────────────────
    console.log('\n[Pass 1] Enforcing existing rules…');
    const violations = enforceRules(hunks, rules);
    console.log(`  → ${violations.length} violation(s) found`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(violations, null, 2));
    console.log(`  → Written to ${OUTPUT_FILE}`);

    // ── Pass 2 ────────────────────────────────────────────────────────────────
    console.log('\n[Pass 2] Asking Gemini for new rule suggestions…');
    const rawSuggestions = await askGemini(diffText, rules);
    console.log(`  → ${rawSuggestions.length} raw suggestion(s) from Gemini`);

    // ── Pass 3 ────────────────────────────────────────────────────────────────
    console.log('\n[Pass 3] Deduplicating suggestions…');
    const newSuggestions = deduplicateSuggestions(rawSuggestions, rules);
    console.log(`  → ${newSuggestions.length} new unique suggestion(s)`);
    fs.writeFileSync('new-suggestions.json', JSON.stringify(newSuggestions, null, 2));
    console.log(`  → Written to new-suggestions.json`);

    console.log('\n=== Analysis complete ===');
    console.log(`Violations: ${violations.length}`);
    console.log(`New rule suggestions: ${newSuggestions.length}`);
})();