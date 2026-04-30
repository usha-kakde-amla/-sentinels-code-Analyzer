/**
 * approve-rule.js
 *
 * Handles a reviewer's approval or rejection of a suggested rule.
 *
 * Workflow:
 *  1. Reads pending-approvals.json to find the rule associated with the token.
 *  2. If action == 'approve', appends the rule to the appropriate rules JSON file.
 *  3. Commits and pushes the updated rules file.
 *  4. Marks the token as consumed so it cannot be reused.
 *
 * Usage:
 *   node approve-rule.js --token <TOKEN> --action approve|reject
 *
 * Env vars:
 *   RULES_DIR      – path to the rules folder   (default: ./rules)
 *   RULES_FILE     – filename inside RULES_DIR   (default: approved-rules.json)
 *   GIT_USER_EMAIL – for the commit              (default: sentinels-bot@github.com)
 *   GIT_USER_NAME  – for the commit              (default: Sentinels Bot)
 *
 * Called automatically by the "add-approved-rule" GitHub Actions workflow,
 * which is triggered by a repository_dispatch event when the reviewer clicks
 * the Approve link.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args  = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      result[args[i].slice(2)] = args[i + 1] || true;
      i++;
    }
  }
  return result;
}

// ── Rule file helpers ────────────────────────────────────────────────────────

function loadRulesFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : [data];
  } catch {
    return [];
  }
}

function isDuplicate(existing, newRule) {
  const newKey = (newRule.id || newRule.name || '').toLowerCase().trim();
  return existing.some(r =>
    (r.id   || '').toLowerCase().trim() === newKey ||
    (r.name || '').toLowerCase().trim() === newKey
  );
}

function appendRuleToFile(filePath, rule) {
  const existing = loadRulesFile(filePath);

  if (isDuplicate(existing, rule)) {
    console.log(`Rule "${rule.id || rule.name}" already exists in ${filePath}. Skipping.`);
    return false;
  }

  // Add metadata
  rule._approved_at = new Date().toISOString();

  existing.push(rule);
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`✅ Rule "${rule.id || rule.name}" appended to ${filePath}`);
  return true;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function gitCommitAndPush(rulesFile, rule) {
  const email = process.env.GIT_USER_EMAIL || 'sentinels-bot@github.com';
  const name  = process.env.GIT_USER_NAME  || 'Sentinels Bot';

  try {
    execSync(`git config user.email "${email}"`);
    execSync(`git config user.name  "${name}"`);
    execSync(`git add "${rulesFile}"`);
    execSync(`git commit -m "chore(sentinels): add approved rule '${rule.id || rule.name}' [skip ci]"`);
    execSync('git push');
    console.log('📦 Rule committed and pushed.');
  } catch (err) {
    console.error('Git commit/push failed:', err.message);
    // Non-fatal in CI — the file is already written locally
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  const token  = args.token;
  const action = (args.action || '').toLowerCase();

  if (!token) {
    console.error('--token is required');
    process.exit(1);
  }

  if (!['approve', 'reject'].includes(action)) {
    console.error('--action must be "approve" or "reject"');
    process.exit(1);
  }

  // ── Load pending approvals ────────────────────────────────────────────────
  const pendingFile = path.resolve(process.env.PENDING_FILE || 'pending-approvals.json');

  if (!fs.existsSync(pendingFile)) {
    console.error(`pending-approvals.json not found at ${pendingFile}`);
    process.exit(1);
  }

  let pendingMap;
  try {
    pendingMap = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (e) {
    console.error('Failed to parse pending-approvals.json:', e.message);
    process.exit(1);
  }

  const entry = pendingMap[token];

  if (!entry) {
    console.error(`Token not found: ${token}`);
    process.exit(1);
  }

  if (entry.status !== 'pending') {
    console.log(`Token already consumed (status: ${entry.status}). Nothing to do.`);
    process.exit(0);
  }

  const { rule } = entry;

  // Mark token as consumed immediately to prevent double-use
  pendingMap[token].status    = action === 'approve' ? 'approved' : 'rejected';
  pendingMap[token].resolved_at = new Date().toISOString();

  // Also consume the sibling token (approve ↔ reject) if it exists
  for (const [t, e] of Object.entries(pendingMap)) {
    if (
      t !== token &&
      e.rule &&
      (e.rule.id || e.rule.name) === (rule.id || rule.name) &&
      e.status === 'pending'
    ) {
      pendingMap[t].status      = 'superseded';
      pendingMap[t].resolved_at = new Date().toISOString();
    }
  }

  fs.writeFileSync(pendingFile, JSON.stringify(pendingMap, null, 2));

  // ── Handle rejection ──────────────────────────────────────────────────────
  if (action === 'reject') {
    console.log(`❌ Rule "${rule.id || rule.name}" was REJECTED. No changes made.`);
    process.exit(0);
  }

  // ── Handle approval ───────────────────────────────────────────────────────
  const rulesDir  = path.resolve(process.env.RULES_DIR  || './rules');
  const rulesFile = path.join(rulesDir, process.env.RULES_FILE || 'approved-rules.json');

  // Ensure rules directory exists
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }

  const added = appendRuleToFile(rulesFile, rule);

  if (added) {
    gitCommitAndPush(rulesFile, rule);
    console.log(`\n🎉 Rule "${rule.id || rule.name}" successfully added to ${rulesFile}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });