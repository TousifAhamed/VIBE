export const CANDIDATE_DELIMITERS = [',', '\t', ';', '|', ':', ' '] as const;

/** Splits one line on `delim`, ignoring delimiters inside double quotes. */
export function countFields(line: string, delim: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      fields++;
    }
  }
  return fields;
}

/**
 * Picks the delimiter that splits the sample into the most consistent number
 * of fields per line. Returns ',' when nothing splits the text, so a single
 * column file still loads.
 */
export function detectDelimiter(sample: string): string {
  const lines = sample
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 50);
  // The last line of a byte sample is usually cut short.
  if (lines.length > 2) {
    lines.pop();
  }
  if (lines.length === 0) {
    return ',';
  }

  let best = ',';
  let bestScore = 0;
  for (const delim of CANDIDATE_DELIMITERS) {
    const counts = lines.map((l) => countFields(l, delim));
    const freq = new Map<number, number>();
    for (const c of counts) {
      freq.set(c, (freq.get(c) ?? 0) + 1);
    }
    let modeCount = 1;
    let modeLines = 0;
    for (const [count, n] of freq) {
      if (n > modeLines || (n === modeLines && count > modeCount)) {
        modeCount = count;
        modeLines = n;
      }
    }
    if (modeCount < 2) {
      continue;
    }
    const consistency = modeLines / lines.length;
    // Spaces appear in ordinary text, so only pick them when nothing else works.
    const penalty = delim === ' ' ? 0.5 : 1;
    const score = consistency * consistency * Math.log2(modeCount + 1) * penalty;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}
