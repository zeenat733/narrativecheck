// Server-side copy of the narrative sentence index, for cases saved before the
// sentence list was stored on the record. Same logic as src/lib/sentences.js.

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'hon', 'rev', 'gen', 'col', 'maj', 'capt',
  'lt', 'sgt', 'cpl', 'ofc', 'det', 'gov', 'dept', 'asst', 'supt', 'approx', 'est', 'etc', 'vs',
  'inc', 'ltd', 'co', 'corp', 'no', 'vol', 'sec', 'art', 'para', 'cfr', 'usc', 'ins', 'ice',
  'cbp', 'fbi', 'dea', 'tsa', 'dhs', 'doj', 'u.s', 'u.s.c', 'u.s.a', 'a.m', 'p.m', 'p.o',
  'd.o.b', 'e.g', 'i.e',
]);

const TERMINAL_ABBREVIATIONS = new Set(['a.m', 'p.m']);

const TRAILING_OPENERS = /^[\s"'“”‘’([\]-]+/;
const TRAILING_CLOSERS = /["'”’)\]]+$/;

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function startsNewSentence(rest) {
  const trimmed = rest.replace(TRAILING_OPENERS, '');
  if (!trimmed) return true;
  return /[A-Z0-9]/.test(trimmed[0]);
}

function isSentenceEnd(source, index) {
  const char = source[index];
  const rest = source.slice(index + 1);

  if (char === '!' || char === '?') {
    return startsNewSentence(rest);
  }

  if (!startsNewSentence(rest)) return false;

  const before = source.slice(0, index).replace(TRAILING_CLOSERS, '');
  const tokenMatch = before.match(/([A-Za-z][A-Za-z.]*|\d+)$/);
  if (!tokenMatch) return false;

  const token = tokenMatch[1];
  const preceding = before.slice(0, tokenMatch.index);

  if (/^\d+$/.test(token)) return false;
  if (/^[A-Za-z]$/.test(token)) {
    return /\($/.test(preceding);
  }

  const key = token.toLowerCase();
  if (TERMINAL_ABBREVIATIONS.has(key)) {
    return /^[A-Z]/.test(rest.replace(TRAILING_OPENERS, ''));
  }
  if (ABBREVIATIONS.has(key)) return false;

  return true;
}

export function splitSentences(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];

  const sentences = [];
  let start = 0;
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === '.' || char === '!' || char === '?') {
      let end = index;
      while (end + 1 < source.length && '.!?'.includes(source[end + 1])) end += 1;

      if (isSentenceEnd(source, end)) {
        const sentence = collapse(source.slice(start, end + 1));
        if (sentence) sentences.push(sentence);
        start = end + 1;
      }
      index = end + 1;
      continue;
    }
    index += 1;
  }

  const tail = collapse(source.slice(start));
  if (tail) sentences.push(tail);

  return sentences;
}

export function toSentenceRecords(text) {
  return splitSentences(text).map((sentence, index) => ({
    label: 'S' + (index + 1),
    text: sentence,
  }));
}