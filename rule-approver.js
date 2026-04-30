/**
 * rule-approver.js
 *
 * Reads new-suggestions.json, sends one approval email per rule,
 * and writes pending-approvals.json so the approve-rule.js handler
 * knows what to commit once a reviewer clicks Approve.
 *
 * Usage:  node rule-approver.js <suggestions-file>
 *
 * Env vars required:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   APPROVAL_EMAIL   – reviewer's address
 *   FROM_EMAIL       – sender address
 *   APPROVE_WEBHOOK  – base URL for the approval endpoint
 *                      e.g. https://your-app.example.com/approve
 *   PR_TITLE         – injected by GitHub Actions
 *   PR_URL           – injected by GitHub Actions
 *   GITHUB_RUN_ID    – injected automatically by GitHub Actions
 *   GITHUB_REPOSITORY– injected automatically by GitHub Actions
 */

'use strict';

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateToken() {
    return crypto.randomBytes(24).toString('hex');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildEmailHtml({ rule, approveUrl, rejectUrl, prTitle, prUrl, runId }) {
    const json = JSON.stringify(rule, null, 2);
    const severity = (rule.severity || 'info').toLowerCase();
    const badgeColor = { error: '#d73a49', warning: '#e36209', info: '#0366d6' }[severity] || '#586069';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Rule Suggestion — Approval Required</title>
  <style>
    body        { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                  background: #f6f8fa; margin: 0; padding: 24px; color: #24292e; }
    .card       { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px;
                  max-width: 640px; margin: 0 auto; overflow: hidden; }
    .header     { background: #24292e; padding: 20px 24px; }
    .header h1  { color: #fff; margin: 0; font-size: 18px; }
    .header p   { color: #8b949e; margin: 4px 0 0; font-size: 13px; }
    .body       { padding: 24px; }
    .badge      { display: inline-block; padding: 2px 8px; border-radius: 12px;
                  font-size: 12px; font-weight: 600; color: #fff;
                  background: ${badgeColor}; text-transform: uppercase; }
    .meta       { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 20px; }
    .meta span  { font-size: 13px; color: #586069; }
    .meta strong{ color: #24292e; }
    pre         { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px;
                  padding: 16px; font-size: 13px; overflow-x: auto;
                  white-space: pre-wrap; word-break: break-word; }
    .desc       { background: #fffbdd; border-left: 4px solid #e36209;
                  padding: 10px 14px; border-radius: 0 4px 4px 0;
                  font-size: 14px; margin: 16px 0; }
    .actions    { display: flex; gap: 12px; margin-top: 24px; }
    .btn        { display: inline-block; padding: 10px 22px; border-radius: 6px;
                  font-size: 14px; font-weight: 600; text-decoration: none;
                  text-align: center; }
    .btn-approve{ background: #2ea44f; color: #fff; }
    .btn-reject { background: #d73a49; color: #fff; }
    .footer     { border-top: 1px solid #e1e4e8; padding: 16px 24px;
                  font-size: 12px; color: #586069; }
  </style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>🛡️ Sentinels — New Rule Suggestion</h1>
    <p>A new code-quality rule requires your approval before it is added.</p>
  </div>
  <div class="body">
    <h2 style="margin:0 0 4px">${escapeHtml(rule.name || rule.id || 'Unnamed Rule')}</h2>
    <span class="badge">${escapeHtml(severity)}</span>

    <div class="meta">
      <span><strong>ID:</strong> ${escapeHtml(rule.id || '—')}</span>
      <span><strong>Category:</strong> ${escapeHtml(rule.category || '—')}</span>
      <span><strong>PR:</strong> <a href="${escapeHtml(prUrl)}">${escapeHtml(prTitle)}</a></span>
      <span><strong>Run:</strong> ${escapeHtml(runId)}</span>
    </div>

    <div class="desc">📋 ${escapeHtml(rule.description || 'No description provided.')}</div>

    ${rule.example ? `<p style="margin:16px 0 4px;font-weight:600">Bad-code example:</p>
    <pre>${escapeHtml(rule.example)}</pre>` : ''}

    ${rule.pattern ? `<p style="margin:16px 0 4px;font-weight:600">Detection pattern:</p>
    <pre>${escapeHtml(rule.pattern)}</pre>` : ''}

    <p style="margin:20px 0 4px;font-weight:600">Full rule JSON:</p>
    <pre>${escapeHtml(json)}</pre>

    <div class="actions">
      <a class="btn btn-approve" href="${approveUrl}">✅ Approve &amp; Add Rule</a>
      <a class="btn btn-reject"  href="${rejectUrl}">❌ Reject Rule</a>
    </div>
  </div>
  <div class="footer">
    This email was generated automatically by the Sentinels Code Analyzer.
    Clicking Approve will add this rule to your rules repository via a GitHub Actions workflow.
    Run ID: ${escapeHtml(runId)}
  </div>
</div>
</body>
</html>`;
}

function buildEmailText({ rule, approveUrl, rejectUrl, prTitle, prUrl, runId }) {
    return `
SENTINELS — NEW RULE SUGGESTION
================================

A new code-quality rule was suggested from PR "${prTitle}".
It must be approved before being added to your rules file.

Rule Name   : ${rule.name || rule.id || 'Unnamed'}
ID          : ${rule.id || '—'}
Severity    : ${rule.severity || '—'}
Category    : ${rule.category || '—'}

Description : ${rule.description || '—'}

${rule.example ? `Bad-code example:\n${rule.example}\n` : ''}
${rule.pattern ? `Detection pattern:\n${rule.pattern}\n` : ''}

Full JSON:
${JSON.stringify(rule, null, 2)}

PR  : ${prTitle}  (${prUrl})
Run : ${runId}

─────────────────────────────────────
APPROVE : ${approveUrl}
REJECT  : ${rejectUrl}
─────────────────────────────────────

This message was sent by the Sentinels Code Analyzer GitHub Action.
`.trim();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const suggestionsFile = process.argv[2] || 'new-suggestions.json';

    if (!fs.existsSync(suggestionsFile)) {
        console.log(`No suggestions file found at ${suggestionsFile}. Nothing to do.`);
        process.exit(0);
    }

    let suggestions;
    try {
        suggestions = JSON.parse(fs.readFileSync(suggestionsFile, 'utf8'));
    } catch (e) {
        console.error('Failed to parse suggestions file:', e.message);
        process.exit(1);
    }

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
        console.log('No new rule suggestions to process.');
        process.exit(0);
    }

    // ── SMTP transporter ────────────────────────────────────────────────────
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER || 'apikey',
            pass: process.env.SMTP_PASS,
        },
    });

    const approvalEmail = process.env.APPROVAL_EMAIL;
    const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;
    const webhookBase = (process.env.APPROVE_WEBHOOK || '').replace(/\/$/, '');
    const prTitle = process.env.PR_TITLE || 'Unknown PR';
    const prUrl = process.env.PR_URL || '#';
    const runId = process.env.GITHUB_RUN_ID || 'local';
    const repo = process.env.GITHUB_REPOSITORY || '';

    if (!approvalEmail) {
        console.error('APPROVAL_EMAIL is not set — cannot send approval emails.');
        process.exit(1);
    }

    // ── Build pending-approvals registry ────────────────────────────────────
    // Each entry maps a token → { rule, status: 'pending' }
    // approve-rule.js reads this file to know which rule to commit.
    const pendingFile = 'pending-approvals.json';
    const pendingMap = fs.existsSync(pendingFile)
        ? JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
        : {};

    let sent = 0;

    for (const rule of suggestions) {
        const approveToken = generateToken();
        const rejectToken = generateToken();

        // Store tokens → rule
        pendingMap[approveToken] = { rule, action: 'approve', status: 'pending', ts: Date.now() };
        pendingMap[rejectToken] = { rule, action: 'reject', status: 'pending', ts: Date.now() };

        // Build URLs
        // If no webhook is configured, fall back to a GitHub Actions dispatch URL hint
        let approveUrl, rejectUrl;
        if (webhookBase) {
            approveUrl = `${webhookBase}?token=${approveToken}&action=approve`;
            rejectUrl = `${webhookBase}?token=${rejectToken}&action=reject`;
        } else {
            // Fallback: instructions URL (reviewer will run approve-rule.js manually)
            const repoUrl = repo ? `https://github.com/${repo}` : 'your repository';
            approveUrl = `${repoUrl}/actions  →  run "Add Approved Rule" workflow with token: ${approveToken}`;
            rejectUrl = `${repoUrl}/actions  →  run "Add Approved Rule" workflow with token: ${rejectToken}`;
        }

        const ctx = { rule, approveUrl, rejectUrl, prTitle, prUrl, runId };

        try {
            await transporter.sendMail({
                from: fromEmail,
                to: approvalEmail,
                subject: `[Sentinels] Approve new rule: "${rule.name || rule.id}" — ${prTitle}`,
                text: buildEmailText(ctx),
                html: buildEmailHtml(ctx),
            });

            console.log(`✉️  Approval email sent for rule: ${rule.id || rule.name}`);
            sent++;
        } catch (err) {
            console.error(`Failed to send email for rule "${rule.id || rule.name}":`, err.message);
        }
    }

    // Persist pending approvals so approve-rule.js can resolve them
    fs.writeFileSync(pendingFile, JSON.stringify(pendingMap, null, 2));
    console.log(`\nSent ${sent}/${suggestions.length} approval email(s).`);
    console.log(`Pending approvals saved to ${pendingFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });