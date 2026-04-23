// ═══════════════════════════════════════════════════════════════
//  aiResolver.js
//  Sends violations + source code to the selected AI provider
//  and returns the fully fixed source code as a string.
//
//  Supported providers:
//    • Groq    — https://api.groq.com/openai/v1/chat/completions
//    • OpenAI  — https://api.openai.com/v1/chat/completions
//    • Gemini  — https://generativelanguage.googleapis.com
//    • Ollama  — http://localhost:11434/api/chat  (local)
// ═══════════════════════════════════════════════════════════════

"use strict";

const https = require("https");
const http  = require("http");

class AIResolver {

  /**
   * Resolve all violations in the given source code using the
   * configured AI provider.
   *
   * @param {string}   sourceCode    Full text of the file
   * @param {object[]} violations    Array of violation objects from RulesEngine
   * @param {string}   languageId   VS Code languageId (e.g. "javascript")
   * @param {object}   config        AI config from VS Code settings
   * @returns {Promise<string>}      Fixed source code
   */
  async resolve(sourceCode, violations, languageId, config) {
    if (!violations || violations.length === 0) {
      throw new Error("No violations to resolve.");
    }

    const provider = (config.provider || "none").toLowerCase();
    if (provider === "none") {
      throw new Error("No AI provider configured. Go to Settings → Sentinels → AI Provider.");
    }

    const prompt = this._buildPrompt(sourceCode, violations, languageId);

    switch (provider) {
      case "groq":    return await this._callGroq(prompt, config);
      case "openai":  return await this._callOpenAI(prompt, config);
      case "gemini":  return await this._callGemini(prompt, config);
      case "ollama":  return await this._callOllama(prompt, config);
      default:
        throw new Error(`Unknown AI provider: ${provider}`);
    }
  }

  // ── Prompt builder ─────────────────────────────────────────

  _buildPrompt(sourceCode, violations, languageId) {
    const violationList = violations.map((v, i) =>
      `${i + 1}. [${v.ruleId}] ${v.title} (Line ${v.line + 1})\n` +
      `   Problem: ${v.message}\n` +
      `   Fix: ${v.fix || "Follow best practices"}\n` +
      `   Code: ${v.matchedText}`
    ).join("\n\n");

    return `You are a senior ${languageId} developer and security expert.

The following source code has ${violations.length} violation(s) that must be fixed.
Fix ALL violations and return ONLY the complete corrected source code.

CRITICAL RULES:
- Return ONLY the fixed source code — no explanations, no markdown, no code fences
- Fix every violation listed below
- Do NOT change any logic that is not related to the violations
- Keep all comments, formatting style, and structure intact
- The output must be valid, compilable ${languageId} code

VIOLATIONS TO FIX:
${violationList}

SOURCE CODE TO FIX:
${sourceCode}`;
  }

  // ── Groq ───────────────────────────────────────────────────

  async _callGroq(prompt, config) {
    if (!config.groqApiKey) throw new Error("Groq API key is missing. Set it in Settings → Sentinels → AI → Groq API Key.");

    const body = JSON.stringify({
      model: config.groqModel || "llama3-70b-8192",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 8000
    });

    const response = await this._postJson(
      "api.groq.com", "/openai/v1/chat/completions",
      { "Authorization": `Bearer ${config.groqApiKey}` },
      body, true
    );

    return this._extractContent(response, "groq");
  }

  // ── OpenAI ─────────────────────────────────────────────────

  async _callOpenAI(prompt, config) {
    if (!config.openaiApiKey) throw new Error("OpenAI API key is missing. Set it in Settings → Sentinels → AI → OpenAI API Key.");

    const body = JSON.stringify({
      model: config.openaiModel || "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 8000
    });

    const response = await this._postJson(
      "api.openai.com", "/v1/chat/completions",
      { "Authorization": `Bearer ${config.openaiApiKey}` },
      body, true
    );

    return this._extractContent(response, "openai");
  }

  // ── Gemini ─────────────────────────────────────────────────

  async _callGemini(prompt, config) {
    if (!config.geminiApiKey) throw new Error("Gemini API key is missing. Set it in Settings → Sentinels → AI → Gemini API Key. Get a free key at https://aistudio.google.com/apikey");

    const model    = config.geminiModel || "gemini-2.5-flash";
    const path     = `/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 16000 }
    });

    const response = await this._postJson(
      "generativelanguage.googleapis.com", path,
      {}, body, true
    );

    return this._extractContent(response, "gemini");
  }

  // ── Ollama (local) ─────────────────────────────────────────

  async _callOllama(prompt, config) {
    const baseUrl = (config.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
    const model   = config.ollamaModel || "llama3";

    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false
    });

    const isHttps  = baseUrl.startsWith("https");
    const hostname = baseUrl.replace(/https?:\/\//, "").split(":")[0];
    const port     = baseUrl.includes(":") ? parseInt(baseUrl.split(":").pop()) : (isHttps ? 443 : 11434);

    const response = await this._postJson(
      hostname, "/api/chat", {}, body, isHttps, port
    );

    return this._extractContent(response, "ollama");
  }

  // ── Response content extractor ─────────────────────────────

  _extractContent(response, provider) {
    try {
      const data = JSON.parse(response);

      let text = "";

      if (provider === "gemini") {
        text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      } else if (provider === "ollama") {
        text = data?.message?.content || data?.choices?.[0]?.message?.content || "";
      } else {
        // Groq and OpenAI use same format
        text = data?.choices?.[0]?.message?.content || "";
      }

      if (!text) throw new Error(`Empty response from ${provider}. Check your API key and model.`);

      // Strip markdown code fences if AI added them despite instructions
      text = text
        .replace(/^```[\w]*\n?/m, "")
        .replace(/\n?```$/m, "")
        .trim();

      return text;
    } catch (e) {
      if (e.message.includes("Empty response")) throw e;
      throw new Error(`Failed to parse ${provider} response: ${e.message}\nRaw: ${response.slice(0, 200)}`);
    }
  }

  // ── HTTP POST helper ───────────────────────────────────────

  _postJson(hostname, path, extraHeaders, body, useHttps = true, port = null) {
    return new Promise((resolve, reject) => {
      const mod = useHttps ? https : http;
      const defaultPort = useHttps ? 443 : 80;

      const options = {
        hostname,
        port: port || defaultPort,
        path,
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...extraHeaders
        },
        timeout: 60000   // 60s — AI can be slow
      };

      const req = mod.request(options, res => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          } else {
            resolve(data);
          }
        });
      });

      req.on("error",   reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("AI request timed out (60s).")); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = AIResolver;
