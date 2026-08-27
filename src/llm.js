import { createRequire } from "module";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

const require = createRequire(import.meta.url);

/**
 * One interface, three backends:
 *
 *   provider.generateJSON({ parts, schema, temperature })
 *     parts:  [{ text } | { image: { mimeType, data: Buffer } }]  in order
 *     schema: JSON Schema whose root is an ARRAY (what the pipeline wants)
 *     → parsed array
 *
 *   vertex  — Gemini on Vertex AI (service account / ADC). Default when a
 *             service-account.json or GOOGLE_CLOUD_PROJECT is present.
 *   gemini  — Gemini Developer API with a plain GEMINI_API_KEY ("AIza…").
 *   openai  — OpenAI vision models with OPENAI_API_KEY.
 *
 * Pick with LLM_PROVIDER / --provider; model with LLM_MODEL / --model.
 */

const RETRYABLE = /RESOURCE_EXHAUSTED|rate limit|429|UNAVAILABLE|overloaded|503|deadline|ECONNRESET/i;

export const withRetry = async (fn, { attempts = 6, baseDelay = 5000 } = {}) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.test(String(error?.message ?? error))) throw error;
      if (attempt === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
    }
  }
  throw lastError;
};

const loadServiceAccount = () => {
  try {
    return require(process.env.SERVICE_ACCOUNT_PATH ?? "../service-account.json");
  } catch {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) : null;
  }
};

const parseJSON = (text) => {
  try {
    const v = JSON.parse(text ?? "");
    return Array.isArray(v) ? v : (v?.items ?? []);
  } catch {
    throw new Error(`Model returned non-JSON: ${String(text).slice(0, 200)}`);
  }
};

// ------------------------------------------------------------------ Gemini

const GEMINI_SAFETY = ["HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map((category) => ({ category, threshold: "BLOCK_NONE" }));

const geminiProvider = (client, name, model) => ({
  name,
  model,
  generateJSON: async ({ parts, schema, temperature = 0 }) => {
    const response = await withRetry(() =>
      client.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: parts.map((p) => (p.text !== undefined ? { text: p.text } : { inlineData: { mimeType: p.image.mimeType, data: p.image.data.toString("base64") } })),
        }],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature, safetySettings: GEMINI_SAFETY },
      }),
    );
    return parseJSON(response.text);
  },
});

const vertex = (model) => {
  const credentials = loadServiceAccount();
  const project = credentials?.project_id ?? credentials?.quota_project_id ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("vertex: need service-account.json, GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_CLOUD_PROJECT");
  const options = { vertexai: true, project, location: process.env.GOOGLE_CLOUD_LOCATION || "global" };
  if (credentials) options.googleAuthOptions = { credentials };
  return geminiProvider(new GoogleGenAI(options), "vertex", model || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite");
};

const gemini = (model) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("gemini: set GEMINI_API_KEY");
  // "AQ." keys are Vertex express mode — still the Vertex endpoint
  return geminiProvider(new GoogleGenAI({ vertexai: apiKey.startsWith("AQ."), apiKey }), "gemini", model || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite");
};

// ------------------------------------------------------------------ OpenAI

const openai = (model) => {
  if (!process.env.OPENAI_API_KEY) throw new Error("openai: set OPENAI_API_KEY");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL });
  const chosen = model || process.env.OPENAI_MODEL || "gpt-5-mini";
  return {
    name: "openai",
    model: chosen,
    generateJSON: async ({ parts, schema, temperature = 0 }) => {
      // OpenAI wants an object root: wrap the array under "items".
      const wrapped = { type: "object", properties: { items: schema }, required: ["items"], additionalProperties: false };
      const content = parts.map((p) =>
        p.text !== undefined
          ? { type: "text", text: p.text }
          : { type: "image_url", image_url: { url: `data:${p.image.mimeType};base64,${p.image.data.toString("base64")}`, detail: "high" } },
      );
      const response = await withRetry(() =>
        client.chat.completions.create({
          model: chosen,
          messages: [{ role: "user", content }],
          response_format: { type: "json_schema", json_schema: { name: "regions", schema: wrapped } },
          ...(/^(o\d|gpt-5)/.test(chosen) ? {} : { temperature }),
        }),
      );
      return parseJSON(response.choices?.[0]?.message?.content);
    },
  };
};

// ------------------------------------------------------------------ factory

const PROVIDERS = { vertex, gemini, openai };

export const detectProvider = () => {
  if (process.env.LLM_PROVIDER) return process.env.LLM_PROVIDER;
  if (loadServiceAccount() || process.env.GOOGLE_CLOUD_PROJECT) return "vertex";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  throw new Error("No LLM credentials found. Set OPENAI_API_KEY, GEMINI_API_KEY, or a Vertex service account (see .env.example).");
};

export const createProvider = ({ provider, model } = {}) => {
  const name = provider || detectProvider();
  const make = PROVIDERS[name];
  if (!make) throw new Error(`Unknown provider "${name}". Use one of: ${Object.keys(PROVIDERS).join(", ")}`);
  return make(model || process.env.LLM_MODEL);
};
