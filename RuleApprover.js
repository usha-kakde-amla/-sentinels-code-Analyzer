#!/usr/bin / env node
/**
 * Sentinels Rule Approver
 *
 * Reads new-suggestions.json, sends one approval email per new rule
 * via SMTP (Gmail / Outlook). Each email contains the rule JSON and
 * an approve link that triggers the rule-commit workflow.
 *
 * Required environment variables:
 *   SMTP_HOST       — e.g. smtp.gmail.com  or  smtp.office365.com
 *   SMTP_PORT       — e.g. 587
 *   SMTP_USER       — your email address
 *   SMTP_PASS       — app password (NOT your login password)
 *   APPROVAL_EMAIL  — who receives the approval request
 *   APPROVE_BASE_URL — base URL for approve webhook
 *                      e.g. https://api.github.com/repos/ORG/REPO/dispatches
 *   GITHUB_TOKEN    — token to trigger the approval workflow
 *   REPO_OWNER      — GitHub org/user that owns the Sentinels repo
 *   SENTINELS_REPO  — name of the Sentinels repo
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ── Config from environment ───────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const APPROVAL_EMAIL = process.env.APPROVAL_EMAIL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const SENTINELS_REPO = process.env.SENTINELS_REPO || '-sentinels-code-Analyzer';
const PR_NUMBER = process.env.PR_NUMBER || 'unknown';
const PR_TITLE = process.env.PR_TITLE || 'PR';
const PR_URL = process.env.PR_URL || '';

const SUGGESTIONS_FILE = process.argv[2] || 'new-suggestions.json';

// ── Validate required env vars ────────────────────────────────────────────────
const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'APPROVAL_EMAIL', 'GITHUB_TOKEN', 'REPO_OWNER'];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

// ── Load suggestions ──────────────────────────────────────────────────────────
if (!fs.existsSync(SUGGESTIONS_FILE)) {
    console.log('No new-suggestions.json found — nothing to approve.');
    process.exit(0);
}

const suggestions = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));

if (!suggestions.length) {
    console.log('No new suggestions to send for approval.');
    process.exit(0);
}

console.log(`📧 Sending approval emails for ${suggestions.length} new rule(s)...`);

// ── Create SMTP transporter ───────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
    },
});

// ── Build approve URL ─────────────────────────────────────────────────────────
// Encodes the rule as a base64 payload in a GitHub repository_dispatch event.
// The approve-rule.yml workflow listens for this event and commits the rule.
function buildApproveUrl(rule) {
    const payload = Buffer.from(JSON.stringify({
        ruleId: rule.RuleId,
        ruleJson: JSON.stringify(rule),
        targetFile: `rules/Suggested.json`,
    })).toString('base64');

    // This is a direct link — clicking it fires a POST to GitHub API via
    // a small redirect service (see approve-redirect.yml). For simplicity
    // we encode everything in the URL as a query param.
    const params = new URLSearchParams({
        token: GITHUB_TOKEN,
        owner: REPO_OWNER,
        repo: SENTINELS_REPO,
        payload: payload,
    });

    return `https://api.github.com/repos/${REPO_OWNER}/${SENTINELS_REPO}/dispatches?${params}`;
}

// ── Build HTML email body ─────────────────────────────────────────────────────
function buildEmailHtml(rule, approveToken) {
    const ruleJson = JSON.stringify(rule, null, 2);
    const approveUrl = `https://api.github.com/repos/${REPO_OWNER}/${SENTINELS_REPO}/dispatches`;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #1a1a2e; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .header h2 { margin: 0; font-size: 18px; }
    .header p  { margin: 4px 0 0; font-size: 13px; opacity: 0.8; }
    .body { border: 1px solid #ddd; border-top: none; padding: 24px; border-radius: 0 0 8px 8px; }
    .rule-card { background: #f8f9fa; border-left: 4px solid #4a90d9; padding: 16px; border-radius: 4px; margin: 16px 0; }
    .rule-card h3 { margin: 0 0 8px; font-size: 15px; color: #1a1a2e; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; text-transform: uppercase; }
    .badge-error   { background: #fde8e8; color: #c0392b; }
    .badge-warning { background: #fef9e7; color: #d68910; }
    .badge-info    { background: #eaf4fb; color: #1a5276; }
    .field { margin: 8px 0; font-size: 13px; }
    .field strong { color: #555; display: inline-block; width: 90px; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 6px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; }
    .btn-approve { display: inline-block; background: #27ae60; color: white; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-size: 15px; font-weight: bold; margin: 16px 8px 0 0; }
    .btn-reject  { display: inline-block; background: #e74c3c; color: white; padding: 12px 28px; border-radius: 6px; text-decoration: none; font-size: 15px; font-weight: bold; margin: 16px 0 0; }
    .token-box { background: #f0f0f0; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 12px; word-break: break-all; margin-top: 12px; }
    .footer { margin-top: 24px; font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h2>🛡️ Sentinels — New Rule Approval Required</h2>
    <p>PR #${PR_NUMBER}: ${PR_TITLE}</p>
  </div>
  <div class="body">
    <p>Gemini suggested a <strong>new rule</strong> that does not exist in your current rule set. Please review and approve or reject it.</p>

    <div class="rule-card">
      <h3>${rule.Title}</h3>
      <span class="badge badge-${(rule.Severity || 'info').toLowerCase()}">${rule.Severity}</span>
      &nbsp;<code style="font-size:12px;color:#555">${rule.RuleId}</code>

      <div class="field" style="margin-top:12px"><strong>Description:</strong> ${rule.Description}</div>
      <div class="field"><strong>Message:</strong> ${rule.Message}</div>
      <div class="field"><strong>Fix:</strong> ${rule.Fix}</div>
      <div class="field"><strong>Detection:</strong> ${(rule.Detection || []).join(', ')}</div>
    </div>

    <p><strong>Rule JSON that will be added to <code>rules/Suggested.json</code>:</strong></p>
    <pre>${ruleJson}</pre>

    <p>To <strong>approve</strong> this rule, copy the token below and run this command, or click the manual steps in the PR.</p>

    <p style="font-size:13px;color:#555">Send this POST request to add the rule:</p>
    <pre>curl -X POST \\
  -H "Authorization: token YOUR_GITHUB_PAT" \\
  -H "Accept: application/vnd.github.v3+json" \\
  https://api.github.com/repos/${REPO_OWNER}/${SENTINELS_REPO}/dispatches \\
  -d '{"event_type":"approve-rule","client_payload":{"token":"${approveToken}","ruleId":"${rule.RuleId}"}}'</pre>

    <p>Or click the button below (opens in browser — requires GitHub login):</p>
    <a class="btn-approve" href="https://github.com/${REPO_OWNER}/${SENTINELS_REPO}/actions/workflows/approve-rule.yml">
      ✅ Go to Approve Workflow
    </a>

    <div class="token-box">
      <strong>Approval token for this rule:</strong><br>
      ${approveToken}
    </div>

    <p style="font-size:13px;color:#888;margin-top:16px">
      To <strong>reject</strong>: simply ignore this email. The rule will NOT be added unless approved.
    </p>

    <div class="footer">
      PR: <a href="${PR_URL}">${PR_URL}</a><br>
      Sentinels repo: github.com/${REPO_OWNER}/${SENTINELS_REPO}<br>
      This email was sent automatically by the Sentinels Code Analysis workflow.
    </div>
  </div>
</body>
</html>`;
}

// ── Send one approval email per suggestion ────────────────────────────────────
async function sendApprovalEmails() {
    // Save approval tokens alongside suggestions so the workflow can verify them
    const tokens = {};

    for (const rule of suggestions) {
        // Generate a unique approval token for this rule
        const approveToken = crypto
            .createHmac('sha256', GITHUB_TOKEN)
            .update(`${rule.RuleId}:${PR_NUMBER}:${Date.now()}`)
            .digest('hex')
            .slice(0, 32);

        tokens[rule.RuleId] = approveToken;

        const html = buildEmailHtml(rule, approveToken);

        const mailOptions = {
            from: `"Sentinels Code Analysis" <${SMTP_USER}>`,
            to: APPROVAL_EMAIL,
            subject: `[Sentinels] New Rule Approval Required: ${rule.Title} (${rule.RuleId})`,
            html,
            text: `New rule suggestion: ${rule.RuleId} — ${rule.Title}\n\nSeverity: ${rule.Severity}\nDescription: ${rule.Description}\nMessage: ${rule.Message}\nFix: ${rule.Fix}\n\nApproval token: ${approveToken}\n\nTo approve, trigger the approve-rule workflow in the Sentinels repo with this token.`,
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            console.log(`✅ Approval email sent for "${rule.RuleId}" → ${info.messageId}`);
        } catch (err) {
            console.error(`❌ Failed to send email for "${rule.RuleId}": ${err.message}`);
        }
    }

    // Save tokens to file so approve-rule.yml can verify them
    fs.writeFileSync('approval-tokens.json', JSON.stringify(tokens, null, 2), 'utf8');
    console.log(`\n📄 Approval tokens saved to approval-tokens.json`);
}

sendApprovalEmails().catch(err => {
    console.error('❌ Fatal error in rule-approver:', err.message);
    process.exit(1);
});