const fs = require('fs');
const sgMail = require('@sendgrid/mail');

const file = process.argv[2];

if (!file || !fs.existsSync(file)) {
    console.log("No suggestions file found");
    process.exit(0);
}

const rules = JSON.parse(fs.readFileSync(file, 'utf8'));

if (!rules.length) {
    console.log("No new rules");
    process.exit(0);
}

// Set API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const msg = {
    to: process.env.APPROVAL_EMAIL,
    from: process.env.FROM_EMAIL,
    subject: '🛡️ Rule Approval Required',
    text: `
New rules suggested by Gemini

PR: ${process.env.PR_TITLE}
${process.env.PR_URL}

${JSON.stringify(rules, null, 2)}
`
};

(async () => {
    try {
        await sgMail.send(msg);
        console.log('📧 Email sent successfully');
    } catch (error) {
        console.error('❌ Email failed:', error.response?.body || error.message);
        process.exit(1);
    }
})();