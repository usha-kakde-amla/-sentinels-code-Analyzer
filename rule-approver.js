const fs = require('fs');
const nodemailer = require('nodemailer');

const file = process.argv[2];

if (!file || !fs.existsSync(file)) {
    console.log("No suggestions file found");
    process.exit(0);
}

const rules = JSON.parse(fs.readFileSync(file, 'utf8'));

if (rules.length === 0) {
    console.log("No new rules");
    process.exit(0);
}

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,   // should be "apikey"
        pass: process.env.SMTP_PASS
    }
});

const body = `
New rules suggested by Gemini

PR: ${process.env.PR_TITLE}
${process.env.PR_URL}

Review and approve:

${JSON.stringify(rules, null, 2)}
`;

(async () => {
    try {
        await transporter.sendMail({
            from: process.env.FROM_EMAIL,   // ✅ FIXED
            to: process.env.APPROVAL_EMAIL,
            subject: "Rule Approval Required",
            text: body
        });

        console.log("📧 Email sent successfully");
    } catch (err) {
        console.error("❌ Email failed:", err.message);
        process.exit(1);
    }
})();