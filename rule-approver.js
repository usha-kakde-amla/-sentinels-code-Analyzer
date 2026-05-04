#!/usr/bin/env node
/**
 * rule-approver.js  – Send one approval email per new rule suggestion.
 *
 * Usage:
 *   node rule-approver.js new-suggestions.json
 *
 * Required env vars (set as GitHub secrets):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   APPROVAL_EMAIL, FROM_EMAIL, APPROVE_WEBHOOK
 *   PR_TITLE, PR_URL, GITHUB_RUN_ID, GITHUB_REPOSITORY
 */

'use strict';

const fs = require('fs');
const nodemailer = require('nodemailer');

// ─── Config ───────────────────────────────────────────────────────────────────
const SUGGESTIONS_FILE = process.argv[2] || 'new-suggestions.json';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || 'apikey';
const SMTP_PASS = process.env.SMTP_PASS || '';
const APPROVAL_EMAIL = process.env.APPROVAL_EMAIL || '';
const FROM_EMAIL = process.env.FROM_EMAIL || '';
const APPROVE_WEBHOOK = process.env.APPROVE_WEBHOOK || '';
const PR_TITLE = process.env.PR_TITLE || '(unknown PR)';
const PR_URL = process.env.PR_URL || '';
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';

// ─── Build approve / reject URLs ─────────────────────────────────────────────
function buildApproveUrl(ruleId, action) {
    if (!APPROVE_WEBHOOK) return `(webhook not configured — see approve-rule.js)`;
    const params = new URLSearchParams({
        ruleId,
        action,
        runId: GITHUB_RUN_ID,
        repo: GITHUB_REPOSITORY,
    });
    return `${APPROVE_WEBHOOK}?${params.toString()}`;
}

// ─── HTML email body ──────────────────────────────────────────────────────────
function buildHtml(rule, approveUrl, rejectUrl) {
    const sev = (rule.Severity || rule.severity || 'warning').toLowerCase();
    const sevColor = { error: '#dc2626', warning: '#d97706', info: '#2563eb' }[sev] || '#6b7280';

    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f9fafb; color:#111; }
  .card { max-width:600px; margin:40px auto; background:#fff; border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,.1); overflow:hidden; }
  .header { background:#1e293b; color:#fff; padding:24px 32px; }
  .header h1 { margin:0; font-size:20px; }
  .header p  { margin:6px 0 0; font-size:13px; color:#94a3b8; }
  .body { padding:28px 32px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:99px; font-size:12px; font-weight:600;
           background:${sevColor}22; color:${sevColor}; text-transform:uppercase; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; margin:16px 0; }
  td { padding:10px 12px; font-size:14px; vertical-align:top; border-bottom:1px solid #f1f5f9; }
  td:first-child { color:#64748b; width:140px; white-space:nowrap; }
  .patterns { font-family:monospace; font-size:12px; background:#f1f5f9; padding:8px; border-radius:6px; }
  .actions { display:flex; gap:12px; margin-top:24px; }
  .btn { display:inline-block; padding:12px 28px; border-radius:8px; font-size:15px; font-weight:600;
         text-decoration:none; text-align:center; }
  .btn-approve { background:#16a34a; color:#fff; }
  .btn-reject  { background:#dc2626; color:#fff; }
  .footer { padding:16px 32px; background:#f8fafc; font-size:12px; color:#94a3b8; border-top:1px solid #f1f5f9; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <h1>🛡️ Sentinels — New Rule Approval Required</h1>
    <p>PR: <strong>${PR_TITLE}</strong> &nbsp;|&nbsp; <a href="${PR_URL}" style="color:#60a5fa">${PR_URL || 'view PR'}</a></p>
  </div>
  <div class="body">
    <div class="badge">${sev}</div>
    <table>
      <tr><td>Rule ID</td>    <td><strong>${rule.RuleId || rule.ruleId}</strong></td></tr>
      <tr><td>Title</td>      <td>${rule.Title || rule.title}</td></tr>
      <tr><td>Category</td>   <td>${rule.Category || rule.category || '—'}</td></tr>
      <tr><td>Description</td><td>${rule.Description || rule.description || '—'}</td></tr>
      <tr><td>Message</td>    <td>${rule.Message || rule.message || '—'}</td></tr>
      <tr><td>Fix</td>        <td>${rule.Fix || rule.fix || '—'}</td></tr>
      <tr><td>Extensions</td> <td>${(rule.FileExtensions || rule.fileExtensions || []).join(', ') || 'all'}</td></tr>
      <tr><td>Patterns</td>   <td><div class="patterns">${(rule.Patterns || rule.patterns || []).join('<br>')}</div></td></tr>
    </table>
    <div class="actions">
      <a href="${approveUrl}" class="btn btn-approve">✅ Approve Rule</a>
      <a href="${rejectUrl}"  class="btn btn-reject">❌ Reject Rule</a>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin-top:16px;">
      Approving adds this rule to your Sentinels rules automatically via the approve-rule.js webhook handler.
    </p>
  </div>
  <div class="footer">
    Sentinels Code Analyzer &nbsp;|&nbsp; Run: ${GITHUB_RUN_ID} &nbsp;|&nbsp; Repo: ${GITHUB_REPOSITORY}
  </div>
</div>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    if (!fs.existsSync(SUGGESTIONS_FILE)) {
        console.log(`[rule-approver] File not found: ${SUGGESTIONS_FILE} — nothing to send.`);
        process.exit(0);
    }

    let suggestions = [];
    try {
        const raw = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));
        suggestions = Array.isArray(raw) ? raw : [];
    } catch (e) {
        console.error(`[rule-approver] Could not parse ${SUGGESTIONS_FILE}: ${e.message}`);
        process.exit(1);
    }

    if (suggestions.length === 0) {
        console.log('[rule-approver] No suggestions to email.');
        process.exit(0);
    }

    if (!SMTP_HOST || !APPROVAL_EMAIL || !FROM_EMAIL) {
        console.error('[rule-approver] Missing SMTP_HOST / APPROVAL_EMAIL / FROM_EMAIL — aborting.');
        process.exit(1);
    }

    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    // Record pending approvals for traceability
    const pending = [];

    for (const rule of suggestions) {
        const ruleId = rule.RuleId || rule.ruleId || `RULE-${Date.now()}`;
        const title = rule.Title || rule.title || 'Unnamed Rule';
        const approveUrl = buildApproveUrl(ruleId, 'approve');
        const rejectUrl = buildApproveUrl(ruleId, 'reject');

        const html = buildHtml(rule, approveUrl, rejectUrl);

        console.log(`[rule-approver] Sending approval email for: ${ruleId} — "${title}"`);

        try {
            const info = await transporter.sendMail({
                from: FROM_EMAIL,
                to: APPROVAL_EMAIL,
                subject: `🛡️ Sentinels — Approve new rule: [${ruleId}] ${title}`,
                html,
                text: `
New Sentinels rule suggestion requires your approval.

Rule ID:     ${ruleId}
Title:       ${title}
Severity:    ${rule.Severity || rule.severity}
Description: ${rule.Description || rule.description || '—'}
Fix:         ${rule.Fix || rule.fix || '—'}

APPROVE: ${approveUrl}
REJECT:  ${rejectUrl}

PR: ${PR_TITLE}
${PR_URL}
        `.trim(),
            });
            console.log(`  ✅ Sent: ${info.messageId}`);
            pending.push({ ruleId, title, status: 'pending', sentAt: new Date().toISOString() });
        } catch (e) {
            console.error(`  ❌ Failed to send for ${ruleId}: ${e.message}`);
            pending.push({ ruleId, title, status: 'email-failed', error: e.message });
        }
    }

    fs.writeFileSync('pending-approvals.json', JSON.stringify(pending, null, 2));
    console.log(`[rule-approver] Done. ${pending.filter(p => p.status === 'pending').length}/${suggestions.length} emails sent.`);
    console.log('[rule-approver] Pending approvals written to pending-approvals.json');
})();