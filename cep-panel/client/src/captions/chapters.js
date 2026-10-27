/**
 * chapters.js — Native Timeline Markers & Social Chapter Engine for EditFlow AI.
 *
 * 100% offline, zero-cloud:
 * 1. autoDetectChapters: analyzes transcript pauses, transition hooks, and speaker changes.
 * 2. formatSocialChapters: formats chapters into YouTube, Spotify, and podcast description formats.
 * 3. parseSocialChapters: parses pasted YouTube timestamps into chapter objects.
 * 4. validateYouTubeChapters: validates YouTube algorithm compliance (00:00 start, >=3 chapters, >=10s gaps).
 */

/**
 * Format seconds into a standard YouTube/timestamp format: mm:ss or hh:mm:ss.
 * @param {number} seconds
 * @param {boolean} [forceHours=false]
 * @returns {string}
 */
export function fmtTimestamp(seconds, forceHours = false) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalSec = Math.floor(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  const pad = (n) => (n < 10 ? '0' + n : String(n));

  if (h > 0 || forceHours) {
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  return pad(m) + ':' + pad(s);
}

/**
 * Parse a timestamp string ("00:00", "0:00", "1:24", "01:24", "01:05:20") to seconds.
 * @param {string} str
 * @returns {number|null} Seconds, or null if invalid
 */
export function parseTimestamp(str) {
  if (!str || typeof str !== 'string') return null;
  const clean = str.trim().replace(/^\[|\]$/g, '');
  const parts = clean.split(':').map(Number);
  if (parts.some((n) => isNaN(n) || n < 0)) return null;

  if (parts.length === 2) {
    // mm:ss
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    // hh:mm:ss
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

/**
 * Common topic transition hooks and their canonical chapter titles.
 */
export const HOOK_PATTERNS = [
  { re: /^(to begin with|first off|firstly|first thing|first step|step one|number one|part one)\b/i, title: 'First Step' },
  { re: /^(secondly|second step|step two|number two|part two)\b/i, title: 'Step Two' },
  { re: /^(thirdly|third step|step three|number three|part three)\b/i, title: 'Step Three' },
  { re: /^(the problem is|here is the problem|the biggest issue|the issue with|the real problem)\b/i, title: 'The Problem' },
  { re: /^(the secret is|here is the secret|the trick is|the key is|secret trick)\b/i, title: 'The Secret' },
  { re: /^(the solution|how to solve|here is how to fix|the fix)\b/i, title: 'The Solution' },
  { re: /^(how it works|how does this work|the mechanism|the strategy|the breakdown)\b/i, title: 'How It Works' },
  { re: /^(why this matters|here is why|this is why|the reason why)\b/i, title: 'Why This Matters' },
  { re: /^(what happens next|the result|the results|the outcome)\b/i, title: 'The Results' },
  { re: /^(next up|moving on to|moving forward|after that)\b/i, title: 'Next Steps' },
  { re: /^(in conclusion|finally|to wrap up|wrapping up|final thoughts|in summary|summary|lastly)\b/i, title: 'Conclusion' },
];

const FILLERS = new Set(['um', 'uh', 'so', 'like', 'actually', 'basically', 'you know', 'well', 'and', 'but', 'now']);

/**
 * Capitalize first letter of words for clean titles.
 */
function cleanSentenceTitle(wordsSlice, maxWords = 5) {
  if (!wordsSlice || !wordsSlice.length) return 'Topic';
  const cleanTokens = [];
  for (const w of wordsSlice) {
    const raw = String(w.text || '').replace(/[^\w\s'-]/g, '').trim();
    if (!raw) continue;
    if (cleanTokens.length === 0 && FILLERS.has(raw.toLowerCase())) continue;
    cleanTokens.push(raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase());
    if (cleanTokens.length >= maxWords) break;
  }
  return cleanTokens.length ? cleanTokens.join(' ') : 'Key Topic';
}

/**
 * Auto-detect chapter transitions from word-level transcript data.
 * @param {Array<{ text: string, start: number, end: number, speaker?: string, hidden?: boolean }>} words
 * @param {object} [options]
 * @param {number} [options.minPause=2.2] Minimum gap (sec) between words to trigger a pause candidate
 * @param {number} [options.minChapterDuration=15.0] Minimum seconds between chapters (YouTube requires >= 10s)
 * @param {boolean} [options.detectSpeakers=true] Trigger chapter on speaker transitions
 * @param {boolean} [options.detectHooks=true] Trigger chapter on hook phrases
 * @param {string} [options.firstChapterTitle='Introduction']
 * @param {number} [options.maxChapters=12]
 * @returns {Array<{ time: number, title: string }>}
 */
export function autoDetectChapters(words, options = {}) {
  const minPause = Math.max(1.5, Number(options.minPause) || 2.2);
  const minGap = Math.max(10.0, Number(options.minChapterDuration) || 15.0);
  const detectSpeakers = options.detectSpeakers !== false;
  const detectHooks = options.detectHooks !== false;
  const firstTitle = options.firstChapterTitle || 'Introduction';
  const maxChapters = Math.max(3, Number(options.maxChapters) || 12);

  const visible = (words || []).filter((w) => !w.hidden && w.text && w.text.trim());
  if (!visible.length) {
    return [{ time: 0, title: firstTitle }];
  }

  const chapters = [{ time: 0, title: firstTitle }];
  let lastChapterTime = 0;

  for (let i = 1; i < visible.length; i++) {
    const w = visible[i];
    const prev = visible[i - 1];
    const timeSinceLast = w.start - lastChapterTime;

    if (timeSinceLast < minGap) {
      continue;
    }

    if (chapters.length >= maxChapters) {
      break;
    }

    const gap = w.start - prev.end;
    let candidateTitle = null;

    // 1. Check Hook Phrases if enabled
    if (detectHooks) {
      const phraseWindow = visible.slice(i, i + 5).map((x) => x.text).join(' ');
      for (const hook of HOOK_PATTERNS) {
        if (hook.re.test(phraseWindow)) {
          candidateTitle = hook.title;
          break;
        }
      }
    }

    // 2. Check Speaker Change if enabled
    if (!candidateTitle && detectSpeakers && w.speaker && prev.speaker && w.speaker !== prev.speaker) {
      candidateTitle = w.speaker + ' Speaks';
    }

    // 3. Check Significant Speech Pause
    if (!candidateTitle && gap >= minPause) {
      candidateTitle = cleanSentenceTitle(visible.slice(i, i + 5));
    }

    if (candidateTitle) {
      chapters.push({
        time: Math.round(w.start * 10) / 10,
        title: candidateTitle,
      });
      lastChapterTime = w.start;
    }
  }

  // YouTube algorithm requires at least 3 chapters.
  // If video is long enough (>= 40s) but fewer than 3 chapters were detected,
  // distribute fallback chapters at prominent sentence pauses to ensure compliance.
  const totalDuration = visible[visible.length - 1].end;
  if (chapters.length < 3 && totalDuration >= 40) {
    const needed = 3 - chapters.length;
    const interval = totalDuration / (needed + 1);

    for (let step = 1; step <= needed; step++) {
      const targetTime = step * interval;
      // Find nearest word break
      const idx = visible.findIndex((w) => w.start >= targetTime);
      if (idx > 0 && idx < visible.length) {
        const w = visible[idx];
        const prev = visible[idx - 1];
        const time = Math.round(w.start * 10) / 10;
        const canAdd = chapters.every((c) => Math.abs(c.time - time) >= minGap);
        if (canAdd) {
          chapters.push({
            time,
            title: cleanSentenceTitle(visible.slice(idx, idx + 5)),
          });
        }
      }
    }
    chapters.sort((a, b) => a.time - b.time);
  }

  return chapters;
}

/**
 * Format chapter objects into clipboard / description text.
 * @param {Array<{ time: number, title: string }>} chapters
 * @param {'youtube'|'brackets'|'hyphen'} [format='youtube']
 * @returns {string}
 */
export function formatSocialChapters(chapters, format = 'youtube') {
  if (!chapters || !chapters.length) return '';

  const maxTime = Math.max(...chapters.map((c) => c.time || 0));
  const forceHours = maxTime >= 3600;

  return chapters
    .map((c) => {
      const ts = fmtTimestamp(c.time, forceHours);
      const title = (c.title || 'Chapter').trim();
      if (format === 'brackets') {
        return `[${ts}] ${title}`;
      } else if (format === 'hyphen') {
        return `${ts} - ${title}`;
      }
      return `${ts} ${title}`;
    })
    .join('\n');
}

/**
 * Parse pasted description / chapter lines into structured chapter objects.
 * Matches:
 *   "00:00 Introduction"
 *   "0:00 - Intro"
 *   "[01:24] The Problem"
 *   "1:24:05 Final Thoughts"
 * @param {string} text
 * @returns {Array<{ time: number, title: string }>}
 */
export function parseSocialChapters(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const chapters = [];

  const timeRe = /(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s*[-–—:]?\s*(.+)/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(timeRe);
    if (match) {
      const sec = parseTimestamp(match[1]);
      if (sec !== null) {
        const title = (match[2] || '').trim();
        chapters.push({
          time: sec,
          title: title || 'Chapter',
        });
      }
    }
  }

  chapters.sort((a, b) => a.time - b.time);
  return chapters;
}

/**
 * Validate chapter set against YouTube description requirements.
 * Rules:
 * 1. The first chapter must start at 00:00 (or 0s).
 * 2. There must be at least 3 chapters listed in ascending order.
 * 3. The minimum length for video chapters is 10 seconds.
 *
 * @param {Array<{ time: number, title: string }>} chapters
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateYouTubeChapters(chapters) {
  const errors = [];
  const warnings = [];

  if (!chapters || !chapters.length) {
    return { valid: false, errors: ['No chapters defined.'], warnings: [] };
  }

  // 1. Starts at 00:00
  if (Math.abs(chapters[0].time) > 0.5) {
    errors.push(`First chapter must start at 00:00 (currently ${fmtTimestamp(chapters[0].time)}).`);
  }

  // 2. Minimum 3 chapters
  if (chapters.length < 3) {
    errors.push(`YouTube requires at least 3 chapters (currently ${chapters.length}).`);
  }

  // 3. Ascending order & 10s gap
  for (let i = 1; i < chapters.length; i++) {
    const curr = chapters[i];
    const prev = chapters[i - 1];

    if (curr.time <= prev.time) {
      errors.push(`Chapter "${curr.title}" (${fmtTimestamp(curr.time)}) is not after previous chapter (${fmtTimestamp(prev.time)}).`);
    } else if (curr.time - prev.time < 10) {
      errors.push(`Gap between "${prev.title}" and "${curr.title}" is less than 10 seconds (${Math.round((curr.time - prev.time) * 10) / 10}s).`);
    }
  }

  // Warning for empty titles
  for (const c of chapters) {
    if (!c.title || !c.title.trim()) {
      warnings.push(`Chapter at ${fmtTimestamp(c.time)} has an empty title.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
