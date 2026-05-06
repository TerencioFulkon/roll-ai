/**
 * Pre-TTS deterministic pass: strip wording that is not substantiated by Visual Claim
 * Verification `allowed_claims` + `verified_visible_facts` for `verified_against_phase_indexes`.
 *
 * Does not call the LLM — only pattern checks and sentence dropping.
 */

/** Banned documentary / hype phrasing (sentence removed if matched). */
const BANNED_NARRATIVE_RES = [
  /\bcircular\s+dance\b/i,
  /\btables\s+turn\b/i,
  /\bdefensive\s+shield\b/i,
  /\boffensive\s+weapon\b/i,
  /\bculmination\b/i,
  /\bpivotal\b/i,
  /\bcrucial\b/i,
  /\bvital\b/i,
  /\bstrategic\s+understanding\b/i,
  /\bleaving\s+a\s+lasting\s+impression\b/i,
  /\bproactive\s+engagement\b/i,
  /\badaptive\s+strategies\b/i,
  /\bmomentum\s+carries\s+forward\b/i,
  /\bcommitted\s+effort\s+at\s+control\b/i
];

/**
 * Risky BJJ claims — substantiation = token appears in corpus from allowed_claims ∪ verified_visible_facts.
 * @type {RegExp[]}
 */
const RISK_PATTERN_LIST = [
  /\bleg\s+entanglement\b/gi,
  /\bside\s+control\b/gi,
  /\bback\s+control\b/gi,
  /\b(?:take|took|taking|get|gets|getting|got|on|to|from|had|have|has)\s+(?:the\s+)?back\b/gi,
  /\brear[-\s]?naked\b/gi,
  /\bsubmission\b/gi,
  /\bdominan(?:ce|t)\b/gi,
  /\b(?:control|controlled|controls|controlling)\b/gi,
  /\bmount(?:ed)?\b/gi,
  /\bpinn(?:ed|ing)?\b/gi,
  /\bsweep(?:s|ing)?\b/gi,
  /\bpass(?:es|ed|ing)?\b/gi,
  /\bpressure\b/gi,
  /\bguard\b/gi,
  /\bescape[sd]?\b/gi,
  /\boffensive\b/gi,
  /\battack(?:s|ed|ing)?\b/gi,
  /\bdefend(?:ed|ing|s)?\b|\bdefen[cs]e\b|\bdefensive\b/gi
];

/**
 * Allowed + verified-visible lines for phases linked to this section (lowercase joined corpus).
 */
function buildVerificationCorpus(verificationRows, verifiedPhaseIndexes) {
  /** @type {string[]} */
  const pieces = [];
  const set = new Set(verifiedPhaseIndexes);
  for (const row of verificationRows) {
    if (!row || typeof row !== "object") continue;
    const pi = Number(/** @type {Record<string, unknown>} */ (row).phase_index);
    if (!Number.isInteger(pi) || !set.has(pi)) continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    for (const key of ["allowed_claims", "verified_visible_facts"]) {
      const arr = r[key];
      if (!Array.isArray(arr)) continue;
      for (const x of arr) {
        if (typeof x === "string" && x.trim()) {
          pieces.push(x.trim());
        }
      }
    }
  }
  return {
    joinedLower: pieces.map((x) => x.toLowerCase()).join(" | "),
    pieceCount: pieces.length
  };
}

function pickingAllowedOnly(verificationRows, verifiedPhaseIndexes) {
  /** @type {string[]} */
  const out = [];
  const set = new Set(verifiedPhaseIndexes);
  for (const row of verificationRows) {
    if (!row || typeof row !== "object") continue;
    const pi = Number(/** @type {Record<string, unknown>} */ (row).phase_index);
    if (!Number.isInteger(pi) || !set.has(pi)) continue;
    const allowed = /** @type {Record<string, unknown>} */ (row).allowed_claims;
    if (!Array.isArray(allowed)) continue;
    for (const x of allowed) {
      if (typeof x === "string" && x.trim()) out.push(x.trim());
    }
  }
  return out;
}

/** @param {string} corpusJoined lowercased " | "-joined corpus lines */
function isRiskMatchSubstantiated(matchedSlice, corpusJoined) {
  const m = matchedSlice.trim().toLowerCase();
  if (!m) return true;
  if (corpusJoined.includes(m)) return true;
  const words = m.split(/\s+/).filter((w) => w.length > 2);
  for (const w of words) {
    if (corpusJoined.includes(w)) return true;
  }
  return false;
}

/**
 * @param {string} sentence
 * @param {string} corpusJoined
 * @returns {boolean}
 */
function sentenceHasUnsubstantiatedRisk(sentence, corpusJoined) {
  const s = sentence;
  for (const re of RISK_PATTERN_LIST) {
    re.lastIndex = 0;
    let rm;
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    while ((rm = r.exec(s)) !== null) {
      const hit = rm[0];
      if (!isRiskMatchSubstantiated(hit, corpusJoined)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} sentence
 */
function sentenceHasBannedPhrase(sentence) {
  return BANNED_NARRATIVE_RES.some((re) => {
    re.lastIndex = 0;
    return re.test(sentence);
  });
}

/**
 * Split narration into sentences (same spirit as timing trim in processVideo).
 * @param {string} text
 */
function splitSentencesRough(text) {
  const t = text.trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

function countWords(t) {
  const s = typeof t === "string" ? t.trim() : "";
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

function buildHedgeSentence(allowedOnly, verifiedFactsFallback) {
  const pick =
    (allowedOnly.length && allowedOnly[0]) ||
    (verifiedFactsFallback.length && verifiedFactsFallback[0]) ||
    null;
  if (pick) {
    const p = pick.trim();
    const rest = p.endsWith(".") ? p.slice(0, -1) : p;
    return `What we can say here is ${rest}.`;
  }
  return "What we can say here stays close to what the footage actually shows—the exact position work is hard to see clearly from this angle.";
}

/**
 * @param {string} jobId
 * @param {unknown} sectionsIn
 * @param {unknown} visualClaimVerification
 * @returns {{
 *   sections: Record<string, unknown>[],
 *   grounding_warnings: string[],
 *   unsupported_claims_removed: string[],
 *   verification_phase_indexes_used: number[]
 * }}
 */
export function applyVoiceoverGrounding(jobId, sectionsIn, visualClaimVerification) {
  /** @type {string[]} */
  const grounding_warnings = [];
  /** @type {string[]} */
  const unsupported_claims_removed = [];

  const sections = Array.isArray(sectionsIn) ? sectionsIn : [];
  const pv = Array.isArray(visualClaimVerification?.phase_verification)
    ? /** @type {unknown[]} */ (visualClaimVerification.phase_verification)
    : [];

  /** @type {Map<number, Record<string, unknown>>} */
  const byPhase = new Map();
  for (const row of pv) {
    if (!row || typeof row !== "object") continue;
    const pi = Number(/** @type {Record<string, unknown>} */ (row).phase_index);
    if (Number.isInteger(pi) && pi >= 0) {
      byPhase.set(pi, /** @type {Record<string, unknown>} */ (row));
    }
  }

  /** @type {Set<number>} */
  const verificationIndexesUsed = new Set();

  const out = sections.map((sec, si) => {
    if (!sec || typeof sec !== "object") {
      return sec;
    }
    const s = /** @type {Record<string, unknown>} */ ({ ...sec });
    const rawText = typeof s.text === "string" ? s.text : String(s.text ?? "");
    const vpi = Array.isArray(s.verified_against_phase_indexes)
      ? s.verified_against_phase_indexes
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 0)
      : [];
    vpi.forEach((i) => verificationIndexesUsed.add(i));

    const corpus = buildVerificationCorpus(pv, vpi);
    const corpusLower = corpus.joinedLower;
    if (!vpi.length) {
      grounding_warnings.push(
        `[job ${jobId}] section ${s.section_id ?? si}: verified_against_phase_indexes empty after repair (unverified) — BJJ claim terms stripped unless plainly non-technical wording`
      );
    } else if (corpus.pieceCount === 0) {
      grounding_warnings.push(
        `[job ${jobId}] section ${s.section_id ?? si}: no allowed_claims/verified_visible_facts for phases [${vpi.join(", ")}] — risk terms cannot be substantiated`
      );
    }

    const allowedOnly = pickingAllowedOnly(pv, vpi);
    /** @type {string[]} */
    const factsOnly = [];
    for (const pi of vpi) {
      const row = byPhase.get(pi);
      const vf = row?.verified_visible_facts;
      if (Array.isArray(vf)) {
        for (const x of vf) {
          if (typeof x === "string" && x.trim()) factsOnly.push(x.trim());
        }
      }
    }

    const sentences = splitSentencesRough(rawText);
    /** @type {string[]} */
    const kept = [];

    for (const sent of sentences) {
      if (sentenceHasBannedPhrase(sent)) {
        const snippet = sent.length > 120 ? `${sent.slice(0, 117)}…` : sent;
        unsupported_claims_removed.push(`[${s.section_id ?? `s${si}`}] removed (banned phrasing): ${snippet}`);
        continue;
      }
      if (sentenceHasUnsubstantiatedRisk(sent, corpusLower)) {
        const snippet = sent.length > 120 ? `${sent.slice(0, 117)}…` : sent;
        unsupported_claims_removed.push(`[${s.section_id ?? `s${si}`}] removed (unsubstantiated risk term): ${snippet}`);
        grounding_warnings.push(
          `[job ${jobId}] section ${s.section_id ?? si}: dropped sentence with risk term not found in verification corpus for phases [${vpi.length ? vpi.join(", ") : "none"}]`
        );
        continue;
      }
      kept.push(sent);
    }

    let newText = kept.join(" ").trim();
    if (!newText) {
      newText = buildHedgeSentence(allowedOnly, factsOnly);
      grounding_warnings.push(
        `[job ${jobId}] section ${s.section_id ?? si}: all sentences removed by grounding — inserted hedge from allowed_claims / verified_visible_facts`
      );
    }

    s.text = newText;
    s.word_count = countWords(newText);
    return s;
  });

  return {
    sections: out,
    grounding_warnings,
    unsupported_claims_removed,
    verification_phase_indexes_used: [...verificationIndexesUsed].sort((a, b) => a - b)
  };
}
