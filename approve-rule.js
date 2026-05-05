#!/usr/bin/env node
/**
 * approve-rule.js  —  Sentinels rule approval handler
 *
 * Called by .github/workflows/approve-rule.yml but can also be run locally.
 *
 * Modes
 * ──────
 *  CLI (base64 payload)
 *    node approve-rule.js --payload <base64url-encoded-rule-JSON> [--action approve|reject]
 *
 *  CLI (lookup by ID)
 *    node approve-rule.js --ruleId RULE-001 [--action approve|reject]
 *    (looks up the rule in SUGGESTIONS_FILE)
 *
 * Required env vars when committing back to GitHub
 *   GITHUB_TOKEN         personal-access-token or Actions token with contents:write
 *   GITHUB_REPOSITORY    e.g. "org/repo"
 *
 * Optional env vars
 *   RULES_DIR            default: ./rules
 *   SUGGESTIONS_FILE     default: ./suggested-rules.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RULES_DIR = process.env.RULES_DIR || './rules';
const SUGGESTIONS_FILE = process.env.SUGGESTIONS_FILE || './suggested-rules.json';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || '';

// ─── Parse CLI args ───────────────────────────────────────────────────────────
function getArg(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : null;
}

const action = (getArg('--action') || 'approve').toLowerCase();
const payload = getArg('--payload');
const ruleId = getArg('--ruleId') || getArg('--rule-id');

// ─── Decode or look up the rule ───────────────────────────────────────────────
function loadRule() {
    if (payload) {
        try {
            return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch (e) {
            console.error('❌ Failed to decode --payload:', e.message);
            process.exit(1);
        }
    }

    if (ruleId) {
        if (!fs.existsSync(SUGGESTIONS_FILE)) {
            console.error(`❌ Suggestions file not found: ${SUGGESTIONS_FILE}`);
            process.exit(1);
        }
        const all = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));
        const rule = (Array.isArray(all) ? all : []).find(
            r => (r.RuleId || r.ruleId || '').toLowerCase() === ruleId.toLowerCase()
        );
        if (!rule) {
            console.error(`❌ Rule ${ruleId} not found in ${SUGGESTIONS_FILE}`);
            process.exit(1);
        }
        return rule;
    }

    console.error('Usage: node approve-rule.js --payload <base64url> | --ruleId <ID>');
    process.exit(1);
}

// ─── Write rule to the correct category file ─────────────────────────────────
function addRuleToFile(rule) {
    if (!fs.existsSync(RULES_DIR)) fs.mkdirSync(RULES_DIR, { recursive: true });

    const category = (rule.Category || rule.category || 'custom')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');

    // Match an existing file case-insensitively so "Security" stays "Security.json"
    const existingFiles = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.json'));
    const match = existingFiles.find(
        f => f.replace('.json', '').toLowerCase() === category
    );
    const targetFile = path.join(RULES_DIR, match || `${category}.json`);

    let rules = [];
    if (fs.existsSync(targetFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
            rules = Array.isArray(raw) ? raw : [raw];
        } catch { rules = []; }
    }

    const id = (rule.RuleId || rule.ruleId || '').toLowerCase();
    if (rules.some(r => (r.RuleId || r.ruleId || '').toLowerCase() === id)) {
        console.log(`ℹ️  Rule ${rule.RuleId} already exists in ${targetFile} — skipping.`);
        return { targetFile, added: false };
    }

    rules.push(rule);
    fs.writeFileSync(targetFile, JSON.stringify(rules, null, 2) + '\n');
    console.log(`✅ Rule ${rule.RuleId} written to ${targetFile}`);
    return { targetFile, added: true };
}

// ─── Commit rule file back via GitHub Contents API ───────────────────────────
async function commitRuleFile(filePath, ruleId) {
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
        console.warn('⚠️  GITHUB_TOKEN / GITHUB_REPOSITORY not set — skipping auto-commit.');
        return;
    }

    const { default: fetch } = await import('node-fetch');
    const relPath = path.relative('.', filePath).replace(/\\/g, '/');
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${relPath}`;
    const content = Buffer.from(fs.readFileSync(filePath, 'utf8')).toString('base64');
    const headers = {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
    };

    // Fetch current SHA (required for update)
    let sha;
    const getRes = await fetch(apiUrl, { headers });
    if (getRes.ok) sha = (await getRes.json()).sha;

    const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
            message: `chore(sentinels): approve rule ${ruleId} [skip ci]`,
            content,
            ...(sha ? { sha } : {}),
        }),
    });

    if (putRes.ok) {
        console.log(`✅ Committed ${relPath} to ${GITHUB_REPO}`);
    } else {
        const err = await putRes.text();
        console.error(`❌ Commit failed (${putRes.status}): ${err.slice(0, 400)}`);
        process.exit(1);
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    const rule = loadRule();
    const id = rule.RuleId || rule.ruleId || 'UNKNOWN';

    if (action === 'reject') {
        console.log(`❌ Rule ${id} rejected — no changes made.`);
        process.exit(0);
    }

    if (action !== 'approve') {
        console.error(`Unknown action "${action}" — expected "approve" or "reject".`);
        process.exit(1);
    }

    const { targetFile, added } = addRuleToFile(rule);
    if (added) await commitRuleFile(targetFile, id);
})().catch(err => {
    console.error('❌ Unexpected error:', err.message);
    process.exit(1);
});