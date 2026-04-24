#!/usr/bin/env node
const fs = require("fs");
const https = require("https");
const args = require("minimist")(process.argv.slice(2));

const diffFile = args.diff;
const outputFile = args.output || "report.json";
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ── Validate inputs ──────────────────────────────────────────────────────────
if (!diffFile || !fs.existsSync(diffFile)) {
    console.error("❌ Diff file missing:", diffFile);
    process.exit(1);
}
if (!apiKey) {
    console.error("❌ GEMINI_API_KEY environment variable not set");
    process.exit(1);
}

// ── Read diff ────────────────────────────────────────────────────────────────
const diffContent = fs.readFileSync(diffFile, "utf8");
if (!diffContent.trim()) {
    console.log("⚠️ Empty diff — no files changed");
    fs.writeFileSync(outputFile, JSON.stringify([], null, 2));
    process.exit(0);
}

console.log(`📄 Diff size: ${diffContent.split("\n").length} lines`);
console.log(`🤖 Using model: ${model}`);

// ── Build prompt ─────────────────────────────────────────────────────────────
const prompt = `You are a strict code reviewer. Analyze the following Git diff and identify ALL security vulnerabilities, performance issues, and bad coding practices in the ADDED lines only (lines starting with +).

For each issue found, respond with a JSON array. Each item must have:
- "file": the file path (from +++ b/... line)
- "fileLine": the actual line number in the new file (integer)
- "ruleId": a short rule code like SEC001, PERF101, VUL002 etc.
- "title": short title of the issue
- "severity": one of "Error", "Warning", or "Info"
- "message": what the problem is
- "fix": how to fix it

Rules to check:
- Hardcoded credentials, passwords, API keys, secrets → SEC001 Error
- SQL injection via string concatenation → SEC002 Error
- Cross-site scripting (XSS) → SEC003 Error
- Path traversal → SEC004 Error
- Weak cryptography (MD5, SHA1, DES) → SEC005 Error
- Insecure random number generation → SEC006 Error
- Command injection → SEC007 Error
- Hardcoded secrets/tokens → VUL001 Error
- SQL injection vulnerability → VUL002 Error
- Insecure deserialization → VUL003 Warning
- Database calls inside loops → PERF001 Warning
- SELECT * usage → PERF002 Warning
- Console.log in production → PERF003 Info
- Missing input validation → VUL004 Warning
- Unparameterized queries → VUL005 Error
- Any other security or performance issue you find

IMPORTANT:
- Only analyze lines starting with + (added lines)
- Skip lines starting with ++ or --- or +++
- Return ONLY a valid JSON array, no markdown, no explanation, no backticks
- If no issues found, return empty array: []

Git diff:
${diffContent}`;

// ── Call Gemini API ───────────────────────────────────────────────────────────
function callGemini(prompt, apiKey, model) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 8192
            }
        });

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Gemini API error ${res.statusCode}: ${data}`));
                    return;
                }
                resolve(data);
            });
        });

        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ── Parse Gemini response ────────────────────────────────────────────────────
function parseResponse(raw) {
    try {
        const parsed = JSON.parse(raw);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Strip markdown code fences if present
        const clean = text
            .replace(/```json\s*/gi, "")
            .replace(/```\s*/g, "")
            .trim();

        const issues = JSON.parse(clean);

        if (!Array.isArray(issues)) {
            console.error("❌ Gemini did not return an array");
            return [];
        }

        // Normalize fields
        return issues.map(issue => ({
            ruleId: issue.ruleId || "UNKNOWN",
            title: issue.title || "Code Issue",
            message: issue.message || "",
            fix: issue.fix || "",
            severity: issue.severity || "Warning",
            file: issue.file || "unknown",
            fileLine: parseInt(issue.fileLine) || 1,
            snippet: issue.snippet || ""
        }));

    } catch (e) {
        console.error("❌ Failed to parse Gemini response:", e.message);
        console.error("Raw response:", raw.slice(0, 500));
        return [];
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    try {
        console.log("🚀 Calling Gemini API...");
        const raw = await callGemini(prompt, apiKey, model);
        const issues = parseResponse(raw);

        console.log(`✅ Gemini found ${issues.length} issue(s)`);
        issues.forEach(i =>
            console.log(`  [${i.severity}] ${i.file}:${i.fileLine} → ${i.ruleId} ${i.title}`)
        );

        fs.writeFileSync(outputFile, JSON.stringify(issues, null, 2));
        console.log(`📄 Report saved: ${outputFile}`);

        const hasErrors = issues.some(i => i.severity.toLowerCase() === "error");
        process.exit(hasErrors ? 1 : 0);

    } catch (err) {
        console.error("❌ Gemini API call failed:", err.message);
        fs.writeFileSync(outputFile, JSON.stringify([], null, 2));
        process.exit(0);
    }
})();