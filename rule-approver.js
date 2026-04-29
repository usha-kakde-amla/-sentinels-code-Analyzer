const fs = require('fs');
const nodemailer = require('nodemailer');

const file = process.argv[2];

// 1. Check file exists
if (!file || !fs.existsSync(file)) {
    console.log("❌ No suggestions file found");
    process.exit(0);
}

// 2. Read rules
const rules = JSON.parse(fs.readFileSync(file, 'utf8'));

if (!Array.isArray(rules) || rules.length === 0) {
    console.log("⚠️ No new rules to send");
    process.exit(0);
}

// 3. Create transporter (SendGrid)
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,                 // smtp.sendgrid.net
    port: Number(process.env.SMTP_PORT),         // 587
    secure: false,
    auth: {
        user: process.env.SMTP_USER,             // MUST be "apikey"
        pass: process.env.SMTP_PASS              // SendGrid API key
    }
});

// 4. Email body
const body = `
🛡️ Sentinels - Rule Approval Required

PR Title:
${process.env.PR_TITLE}

PR Link:
${process.env.PR_URL}

----------------------------------------

New rules suggested by Gemini:

${JSON.stringify(rules, null, 2)}

----------------------------------------

Please review and approve these rules.
`;

// 5. Send email
(async () => {
    try {
        await transporter.sendMail({
            from: process.env.FROM_EMAIL,        // ✅ VERIFIED sender
            to: process.env.APPROVAL_EMAIL,
            subject: "🛡️ Rule Approval Required",
            text: body
        });

        console.log("📧 Email sent successfully");
    } catch (err) {
        console.error("❌ Email failed:", err.message);
        process.exit(1);
    }
})();