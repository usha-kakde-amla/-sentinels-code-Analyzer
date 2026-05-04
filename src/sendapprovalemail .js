/**
 * scripts/send-approval-email.js
 *
 * Reads suggested-rules.json produced by pr-analyzer.js and sends
 * a styled HTML approval email for each suggested rule.
 *
 * Supports two transports — set the matching secrets in GitHub:
 *   SendGrid : SENDGRID_API_KEY  (recommended)
 *   SMTP     : SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE
 *
 * Usage (called automatically by sentinels-analysis.yml):
 *   node scripts/send-approval-email.js \
 *     --suggestions suggested-rules.json \
 *     --approver    approver@company.com \
 *     --pr-number   42 \
 *     --pr-url      https://github.com/org/repo/pull/42 \
 *     --repo        org/repo \
 *     --run-id      1234567890
 */

const fs = require('fs');
const args = require('minimist')(process.argv.slice(2));

// ── Config ────────────────────────────────────────────────────────────────────
const SUGGESTIONS_FILE = args.suggestions || 'suggested-rules.json';
const APPROVER_EMAIL = args.approver || process.env.APPROVER_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || 'sentinels-bot@yourcompany.com';
const FROM_NAME = process.env.FROM_NAME || 'Sentinels Code Analyzer';
const PR_NUMBER = args['pr-number'] || process.env.PR_NUMBER || '?';
const PR_URL = args['pr-url'] || process.env.PR_URL || '#';
const REPO = args.repo || process.env.GITHUB_REPO || 'unknown/repo';
const RUN_ID = args['run-id'] || process.env.GITHUB_RUN_ID || '';

// ── Load suggestions ──────────────────────────────────────────────────────────
if (!fs.existsSync(SUGGESTIONS_FILE)) {
    console.log('No suggested-rules.json found — nothing to email.');
    process.exit(0);
}

const suggestions = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));

if (!suggestions || suggestions.length === 0) {
    console.log('No new rule suggestions — skipping email.');
    process.exit(0);
}

if (!APPROVER_EMAIL) {
    console.error('❌ APPROVER_EMAIL not set. Pass --approver or set the env var.');
    process.exit(1);
}

// ── Build approve URL ─────────────────────────────────────────────────────────
// Encodes the full rule as base64url so approve-rule.yml can decode it
// without needing a separate datastore.
function buildApproveUrl(rule) {
    const payload = Buffer.from(JSON.stringify(rule)).toString('base64url');
    return (
        `https://github.com/${REPO}/actions/workflows/approve-rule.yml` +
        `?rule=${encodeURIComponent(payload)}&pr=${PR_NUMBER}`
    );
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function severityBadge(severity) {
    const map = {
        error: { bg: '#fee2e2', fg: '#991b1b', label: '🔴 ERROR' },
        warning: { bg: '#fef9c3', fg: '#854d0e', label: '🟡 WARNING' },
        info: { bg: '#dbeafe', fg: '#1e40af', label: '🔵 INFO' },
    };
    const c = map[(severity || 'info').toLowerCase()] || map.info;
    return `<span style="background:${c.bg};color:${c.fg};padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;">${c.label}</span>`;
}

function ruleCard(rule, index) {
    const approveUrl = buildApproveUrl(rule);
    const detectionHtml = Array.isArray(rule.Detection) && rule.Detection.length
        ? `<div style="background:#f9fafb;border-left:3px solid #6366f1;padding:10px 14px;border-radius:4px;margin-bottom:14px;">
             <div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em;">Detection Patterns</div>
             <ul style="margin:0;padding-left:18px;font-size:13px;color:#374151;">
               ${rule.Detection.map(d => `<li>${escapeHtml(d)}</li>`).join('')}
             </ul>
           </div>`
        : '';

    const exampleHtml = rule.example
        ? `<div style="background:#1e1e2e;border-radius:8px;padding:14px;margin-bottom:16px;">
             <div style="font-size:11px;font-weight:600;color:#a1a1aa;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em;">Example from PR</div>
             <pre style="margin:0;font-size:12px;color:#cdd6f4;white-space:pre-wrap;word-break:break-all;">${escapeHtml(rule.example)}</pre>
           </div>`
        : '';

    return `
<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:20px;">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
    <span style="background:#f3f4f6;color:#374151;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;">#${index + 1}</span>
    ${severityBadge(rule.Severity)}
    <code style="background:#f3f4f6;padding:2px 8px;border-radius:6px;font-size:13px;color:#6b7280;">${escapeHtml(rule.RuleId)}</code>
  </div>

  <h3 style="margin:0 0 8px;font-size:16px;color:#111827;">${escapeHtml(rule.Title)}</h3>
  <p style="margin:0 0 14px;color:#4b5563;font-size:14px;line-height:1.6;">${escapeHtml(rule.Description || rule.Message || '')}</p>

  ${detectionHtml}

  ${rule.Fix ? `
  <div style="background:#f0fdf4;border-left:3px solid #22c55e;padding:10px 14px;border-radius:4px;margin-bottom:14px;">
    <div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">Suggested Fix</div>
    <p style="margin:0;font-size:13px;color:#374151;">${escapeHtml(rule.Fix)}</p>
  </div>` : ''}

  ${exampleHtml}

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;">
    <a href="${approveUrl}"
       style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:14px;">
      ✅ Approve &amp; Add Rule
    </a>
    <a href="${PR_URL}"
       style="display:inline-block;background:#f3f4f6;color:#374151;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:14px;">
      🔗 View PR
    </a>
  </div>
</div>`;
}

function buildEmailHtml() {
    const cards = suggestions.map((r, i) => ruleCard(r, i)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%);padding:32px 36px;border-radius:12px 12px 0 0;">
          <h1 style="margin:0;color:#ffffff;font-size:22px;">🛡️ Sentinels — New Rule Suggestions</h1>
          <p style="margin:8px 0 0;color:#c7d2fe;font-size:14px;">
            PR <strong>#${PR_NUMBER}</strong> in <strong>${escapeHtml(REPO)}</strong>
            triggered <strong>${suggestions.length}</strong> new rule suggestion${suggestions.length > 1 ? 's' : ''}.
          </p>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#f9fafb;padding:28px 36px 8px;">
          <p style="margin:0 0 20px;color:#4b5563;font-size:14px;line-height:1.6;">
            Gemini analysed the pull request and identified the following patterns that could
            become reusable rules. Review each suggestion and click
            <strong>Approve &amp; Add Rule</strong> to automatically commit it to the
            <code style="background:#e5e7eb;padding:1px 5px;border-radius:4px;">rules/</code> folder.
          </p>
          ${cards}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 36px 36px;background:#f9fafb;border-radius:0 0 12px 12px;">
          <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;">
            Sent by Sentinels Code Analyzer ·
            Run <a href="https://github.com/${REPO}/actions/runs/${RUN_ID}" style="color:#6366f1;">#${escapeHtml(RUN_ID)}</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Transports ────────────────────────────────────────────────────────────────
async function sendViaSendGrid(html, subject) {
    const key = process.env.SENDGRID_API_KEY;
    if (!key) throw new Error('SENDGRID_API_KEY not set');

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: APPROVER_EMAIL }] }],
            from: { email: FROM_EMAIL, name: FROM_NAME },
            subject,
            content: [{ type: 'text/html', value: html }],
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`SendGrid error ${res.status}: ${text}`);
    }
    console.log(`✅ Approval email sent to ${APPROVER_EMAIL} via SendGrid`);
}

async function sendViaSmtp(html, subject) {
    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { throw new Error('nodemailer not installed — run: npm install nodemailer'); }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
        from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to: APPROVER_EMAIL,
        subject,
        html,
    });
    console.log(`✅ Approval email sent to ${APPROVER_EMAIL} via SMTP`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    const subject = `🛡️ [Sentinels] ${suggestions.length} new rule suggestion${suggestions.length > 1 ? 's' : ''} from PR #${PR_NUMBER}`;
    const html = buildEmailHtml();

    // Always write preview for CI artifact upload
    fs.writeFileSync('approval-email-preview.html', html);
    console.log(`📧 Sending approval email for ${suggestions.length} suggestion(s) to ${APPROVER_EMAIL}`);

    if (process.env.SENDGRID_API_KEY) {
        await sendViaSendGrid(html, subject);
    } else if (process.env.SMTP_HOST) {
        await sendViaSmtp(html, subject);
    } else {
        console.warn('⚠️  No email transport configured (set SENDGRID_API_KEY or SMTP_HOST).');
        console.warn('    Email HTML written to approval-email-preview.html for inspection.');
    }
})().catch(err => {
    console.error('❌ Failed to send email:', err.message);
    process.exit(1);
});