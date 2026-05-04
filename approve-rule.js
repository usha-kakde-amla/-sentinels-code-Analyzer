#!/usr/bin/env node
/**
 * approve-rule.js  – Webhook / CLI handler that commits an approved rule.
 *
 * Two usage modes:
 *
 *  1. HTTP mode (Express):
 *       PORT=3001 node approve-rule.js
 *       GET /?ruleId=RULE-001&action=approve&runId=123&repo=org/repo
 *
 *  2. CLI mode (direct approval):
 *       node approve-rule.js --ruleId RULE-001 --action approve
 *
 * The approved rule is read from new-suggestions.json (or a path you specify),
 * appended to rules/<Category>.json (or rules/custom.json if no category),
 * and committed back to the repo via the GitHub API.
 *
 * Required env vars:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY  (set automatically in Actions)
 *   RULES_DIR  (default: ./rules)
 *   SUGGESTIONS_FILE  (default: ./new-suggestions.json)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RULES_DIR = process.env.RULES_DIR || './rules';
const SUGGESTIONS_FILE = process.env.SUGGESTIONS_FILE || './new-suggestions.json';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || '';

// ─── Core: add rule to appropriate JSON file ──────────────────────────────────
function addRuleToFile(rule, rulesDir) {
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });

    const category = (rule.Category || rule.category || 'custom')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');
    const targetFile = path.join(rulesDir, `${category}.json`);

    let existing = [];
    if (fs.existsSync(targetFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
            existing = Array.isArray(raw) ? raw : [raw];
        } catch { existing = []; }
    }

    // Guard against double-adding
    const id = (rule.RuleId || rule.ruleId || '').toLowerCase();
    if (existing.some(r => (r.RuleId || r.ruleId || '').toLowerCase() === id)) {
        console.log(`[approve-rule] Rule ${rule.RuleId} already exists in ${targetFile} — skipping.`);
        return { targetFile, alreadyExists: true };
    }

    existing.push(rule);
    fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2));
    console.log(`[approve-rule] ✅ Rule ${rule.RuleId} added to ${targetFile}`);
    return { targetFile, alreadyExists: false };
}

// ─── Commit changed rule file via GitHub API ──────────────────────────────────
async function commitRuleFile(filePath, repo, token, ruleId) {
    if (!token || !repo) {
        console.warn('[approve-rule] No GITHUB_TOKEN or GITHUB_REPOSITORY — skipping auto-commit.');
        return;
    }
    const { default: fetch } = await import('node-fetch');
    const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const content = Buffer.from(fs.readFileSync(filePath, 'utf8')).toString('base64');

    // Get current SHA (needed for update)
    let sha = undefined;
    const getRes = await fetch(apiBase, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (getRes.ok) {
        const data = await getRes.json();
        sha = data.sha;
    }

    const body = {
        message: `chore(sentinels): approve rule ${ruleId} [skip ci]`,
        content,
        ...(sha ? { sha } : {}),
    };

    const putRes = await fetch(apiBase, {
        method: 'PUT',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (putRes.ok) {
        console.log(`[approve-rule] ✅ Committed ${filePath} to ${repo}`);
    } else {
        const err = await putRes.text();
        console.error(`[approve-rule] ❌ Commit failed: ${err.slice(0, 300)}`);
    }
}

// ─── Find rule in suggestions file ───────────────────────────────────────────
function findRule(ruleId, suggestionsFile) {
    if (!fs.existsSync(suggestionsFile)) return null;
    try {
        const all = JSON.parse(fs.readFileSync(suggestionsFile, 'utf8'));
        return (Array.isArray(all) ? all : []).find(
            r => (r.RuleId || r.ruleId || '').toLowerCase() === ruleId.toLowerCase()
        ) || null;
    } catch { return null; }
}

// ─── HTTP server mode ─────────────────────────────────────────────────────────
function startServer() {
    const http = require('http');
    const PORT = parseInt(process.env.PORT || '3001', 10);

    http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const ruleId = url.searchParams.get('ruleId') || '';
        const action = (url.searchParams.get('action') || '').toLowerCase();

        if (!ruleId) {
            res.writeHead(400); res.end('Missing ruleId'); return;
        }

        if (action === 'approve') {
            const rule = findRule(ruleId, SUGGESTIONS_FILE);
            if (!rule) {
                res.writeHead(404); res.end(`Rule ${ruleId} not found in ${SUGGESTIONS_FILE}`); return;
            }
            const { targetFile, alreadyExists } = addRuleToFile(rule, RULES_DIR);
            if (!alreadyExists) {
                await commitRuleFile(targetFile, GITHUB_REPO, GITHUB_TOKEN, ruleId);
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<h2>✅ Rule ${ruleId} approved and added to ${path.basename(targetFile)}.</h2>`);
        } else if (action === 'reject') {
            console.log(`[approve-rule] Rule ${ruleId} rejected via webhook.`);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<h2>❌ Rule ${ruleId} rejected. No changes made.</h2>`);
        } else {
            res.writeHead(400); res.end(`Unknown action: ${action}`);
        }
    }).listen(PORT, () => {
        console.log(`[approve-rule] Webhook server listening on port ${PORT}`);
    });
}

// ─── CLI mode ─────────────────────────────────────────────────────────────────
async function runCli() {
    const args = process.argv.slice(2);
    const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
    const ruleId = get('--ruleId') || get('--rule-id');
    const action = (get('--action') || 'approve').toLowerCase();

    if (!ruleId) {
        console.error('Usage: node approve-rule.js --ruleId RULE-001 [--action approve|reject]');
        process.exit(1);
    }

    if (action === 'reject') {
        console.log(`[approve-rule] Rule ${ruleId} rejected. No changes.`);
        process.exit(0);
    }

    const rule = findRule(ruleId, SUGGESTIONS_FILE);
    if (!rule) {
        console.error(`[approve-rule] Rule ${ruleId} not found in ${SUGGESTIONS_FILE}`);
        process.exit(1);
    }

    const { targetFile, alreadyExists } = addRuleToFile(rule, RULES_DIR);
    if (!alreadyExists) {
        await commitRuleFile(targetFile, GITHUB_REPO, GITHUB_TOKEN, ruleId);
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
if (process.argv.includes('--serve')) {
    startServer();
} else if (process.argv.includes('--ruleId') || process.argv.includes('--rule-id')) {
    runCli().catch(e => { console.error(e); process.exit(1); });
} else {
    // Default: start server if PORT is set, else print help
    if (process.env.PORT) {
        startServer();
    } else {
        console.log(`
approve-rule.js — Sentinels rule approval handler

Modes:
  HTTP server:  PORT=3001 node approve-rule.js
  CLI:          node approve-rule.js --ruleId RULE-001 --action approve

Env vars:
  GITHUB_TOKEN, GITHUB_REPOSITORY  – for auto-commit
  RULES_DIR                        – default: ./rules
  SUGGESTIONS_FILE                 – default: ./new-suggestions.json
    `.trim());
        process.exit(0);
    }
}