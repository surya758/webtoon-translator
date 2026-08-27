import fs from "node:fs/promises";

/**
 * Per-series memory, kept in a JSON file the user passes with --series.
 *
 *   glossary:   { "무림맹": { en: "Murim Alliance", note: "org" }, ... }
 *   characters: { "Namgung Hyun": { voice: "blunt, swears", pronouns: "he", note: "" }, ... }
 *   recent:     [ { page, lines: [{ speaker, original, translation }] }, ... ]   (last N pages)
 *
 * Before a page is translated the file becomes a context block in the
 * prompt (names stay consistent, characters keep their voice, running
 * jokes survive page breaks). After the page, `learn()` asks the model for
 * additions and merges them in — never overwriting an entry the user has
 * edited by hand (entries carry `locked: true` if you want that).
 */
const EMPTY = { glossary: {}, characters: {}, recent: [] };
const RECENT_PAGES = 6;
const RECENT_LINES = 80;

export class Series {
  constructor(file, data) {
    this.file = file;
    this.data = { ...EMPTY, ...data };
  }
  static async load(file) {
    if (!file) return null;
    let data = {};
    try { data = JSON.parse(await fs.readFile(file, "utf8")); } catch { /* new series */ }
    return new Series(file, data);
  }
  async save() {
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2));
  }

  /** Prompt block: glossary + voice sheet + recent dialogue. */
  contextBlock({ exclude } = {}) {
    const { glossary, characters } = this.data;
    const recent = this.data.recent.filter((p) => p.page !== exclude);
    const out = [];
    const g = Object.entries(glossary);
    if (g.length) out.push("GLOSSARY (use these renderings exactly):\n" + g.map(([k, v]) => `- ${k} → ${v.en}${v.note ? ` (${v.note})` : ""}`).join("\n"));
    const c = Object.entries(characters);
    if (c.length) out.push("CHARACTERS (keep each voice consistent):\n" + c.map(([k, v]) => `- ${k}: ${[v.pronouns, v.voice, v.note].filter(Boolean).join("; ")}`).join("\n"));
    const lines = recent.flatMap((p) => p.lines).slice(-RECENT_LINES);
    if (lines.length) out.push("PREVIOUS PAGES (most recent last) — continue this conversation naturally:\n" + lines.map((l) => `${l.speaker ? l.speaker + ": " : ""}${l.original} → ${l.translation}`).join("\n"));
    return out.join("\n\n");
  }

  /** Hash-stable summary of what influences translation (for cache keys). */
  fingerprint({ exclude } = {}) {
    const { glossary, characters } = this.data;
    const recent = this.data.recent.filter((p) => p.page !== exclude);
    return JSON.stringify({ glossary, characters, tail: recent.flatMap((p) => p.lines).slice(-RECENT_LINES) });
  }

  remember(page, boxes) {
    const lines = boxes
      .filter((b) => b.original && b.translation && ["dialogue", "thought", "caption"].includes(b.role))
      .map((b) => ({ speaker: b.speaker || "", original: b.original, translation: b.translation }));
    if (!lines.length) return;
    this.data.recent = [...this.data.recent.filter((p) => p.page !== page), { page, lines }].slice(-RECENT_PAGES);
  }

  /** Ask the model what this page taught us; merge without clobbering locked entries. */
  async learn(provider, boxes, { sourceLang } = {}) {
    const lines = boxes.filter((b) => b.original && b.translation && b.role !== "credit");
    if (!lines.length) return { glossary: 0, characters: 0 };
    const SCHEMA = {
      type: "object",
      properties: {
        glossary: { type: "array", items: { type: "object", properties: { term: { type: "string" }, en: { type: "string" }, note: { type: "string" } }, required: ["term", "en"] } },
        characters: { type: "array", items: { type: "object", properties: { name: { type: "string" }, pronouns: { type: "string" }, voice: { type: "string" }, note: { type: "string" } }, required: ["name"] } },
      },
      required: ["glossary", "characters"],
    };
    const prompt = `You maintain the localization bible for a webtoon series.
Known glossary and characters:
${this.contextBlock() || "(none yet)"}

Lines just translated on the current page${sourceLang ? ` (source language: ${sourceLang})` : ""}:
${lines.map((l) => `${l.speaker ? l.speaker + ": " : ""}${l.original} → ${l.translation}`).join("\n")}

Return ONLY new or corrected entries:
- glossary: proper nouns, titles, techniques, places, recurring slang or catchphrases that must be rendered the same way every time (term in the source language → the English used). Skip ordinary words.
- characters: speakers seen here, with pronouns and a 3-8 word voice description (register, tics, how they address others). Update an existing character only if this page reveals something new.
Return empty arrays if nothing is new.`;
    const result = await provider.generateJSON({ parts: [{ text: prompt }], schema: SCHEMA, temperature: 0 });
    let g = 0, c = 0;
    for (const e of result.glossary ?? []) {
      const key = e.term?.trim(); if (!key || !e.en?.trim()) continue;
      const cur = this.data.glossary[key];
      if (cur?.locked) continue;
      if (!cur || cur.en !== e.en || (e.note && cur.note !== e.note)) { this.data.glossary[key] = { ...cur, en: e.en.trim(), ...(e.note ? { note: e.note } : {}) }; g++; }
    }
    for (const e of result.characters ?? []) {
      const key = e.name?.trim(); if (!key) continue;
      const cur = this.data.characters[key];
      if (cur?.locked) continue;
      const next = { ...cur, ...(e.pronouns ? { pronouns: e.pronouns } : {}), ...(e.voice ? { voice: e.voice } : {}), ...(e.note ? { note: e.note } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(cur ?? {})) { this.data.characters[key] = next; c++; }
    }
    return { glossary: g, characters: c };
  }
}
