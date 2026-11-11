// Pass-2 verification for the gap engine.
//
// Everything in this module is deterministic: quote tracing, the confidence
// floor, duplicate merging, and the cross-checks only code can settle (dates,
// times, crosswalk, rights advisement, removal-based charges). No AI runs here.
//
// The module also owns the field list, prompt and response schema for the second
// (verifier) model pass so both passes read the same record.

import { INA_TO_USC } from './citation.ts';

export const MIN_CONFIDENCE = 0.6;

const SEVERITY_RANK = { Critical: 3, Major: 2, Minor: 1 };

const STRUCTURED_FIELDS = [
  'caseNumber',
  'formType',
  'selectedCharge',
  'encounterDate',
  'encounterTime',
  'encounterLocation',
  'stationOrPort',
  'mannerOfEncounter',
  'subjectName',
  'subjectDOB',
  'citizenship',
  'mannerOfEntry',
  'placeOfEntry',
  'dateOfEntry',
  'immigrationHistory',
  'priorRemovals',
  'subjectStatements',
  'documentsPresented',
  'status'
];

const SKIP_FIELDS = new Set(['narrativeSentences', 'id', 'created_date', 'updated_date', 'created_by_id']);

function collapse(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return collapse(value).toLowerCase();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function caseFieldBlock(caseRecord) {
  return STRUCTURED_FIELDS.map(
    (name) => name + ': ' + (collapse(caseRecord?.[name]) || '(not provided)')
  ).join('\n');
}

// ---------------------------------------------------------------------------
// A1. Quote tracing: a flag must quote text that really sits in its source.
// ---------------------------------------------------------------------------

function sentenceAt(label, sentences) {
  const match = String(label || '').match(/^s\s*(\d+)$/i);
  if (!match) return null;
  const record = (sentences || [])[Number(match[1]) - 1];
  return record ? collapse(record.text) : null;
}

export function sourceText(source, caseRecord, sentences) {
  const parts = String(source || '')
    .split(/[,;/]|\band\b|\bor\b/i)
    .map((part) => part.replace(/[()[\]]/g, ' ').trim())
    .filter(Boolean);

  const chunks = [];
  for (const part of parts) {
    const label = part.match(/\bs\s*(\d+)\b/i);
    const sentence = label ? sentenceAt('S' + label[1], sentences) : null;
    if (sentence) {
      chunks.push(sentence);
      continue;
    }
    if (/narrative/i.test(part)) {
      chunks.push(collapse(caseRecord?.narrative));
      continue;
    }
    const lower = part.toLowerCase();
    for (const key of Object.keys(caseRecord || {})) {
      if (SKIP_FIELDS.has(key)) continue;
      if (lower.includes(key.toLowerCase())) chunks.push(collapse(caseRecord[key]));
    }
  }

  return chunks.filter(Boolean).join('\n');
}

export function verifyFlagQuotes(flags, caseRecord, sentences) {
  const kept = [];
  const unverified = [];

  for (const flag of flags || []) {
    const quote = norm(flag?.quote);
    if (!quote) {
      // Only a MISSING flag may stand without a quote. An inconsistency or an unclear
      // entry has to show the wording it rests on, or there is nothing to check.
      if (String(flag?.type || '').trim().toUpperCase() === 'MISSING') kept.push(flag);
      else unverified.push(flag);
      continue;
    }
    const haystack = norm(sourceText(flag?.source, caseRecord, sentences));
    if (haystack.includes(quote)) kept.push(flag);
    else unverified.push(flag);
  }

  return { kept, unverified };
}

// ---------------------------------------------------------------------------
// A1b. Fields the narrative never mentions.
// A fact that sits in the structured fields and appears nowhere in the narrative is
// not an inconsistency: nothing in the narrative conflicts with it. A field that is
// merely more specific than the narrative is not a conflict either. A flag built on
// the narrative's silence is therefore dropped, not reported as a contradiction.
// ---------------------------------------------------------------------------

const NARRATIVE_SILENCE =
  /(does not mention|doesn't mention|no mention|never mentions|makes no mention|makes no reference|no reference|is silent|silent on|omits|omitted|absent from the narrative|not (?:stated|recorded|mentioned|addressed|included) in the narrative|nothing about|fails to mention|does not specify|doesn't specify|not specified|does not state|doesn't state|does not detail|doesn't detail|does not say|doesn't say|does not describe|doesn't describe)/i;

function structuredFieldOf(name) {
  const value = norm(name).replace(/[^a-z0-9]/g, '');
  if (!value) return '';
  const found = STRUCTURED_FIELDS.find((field) => {
    const key = norm(field).replace(/[^a-z0-9]/g, '');
    return value.indexOf(key) !== -1 || value.indexOf(key.replace(/s$/, '')) !== -1;
  });
  return found || '';
}

export function dropSilentFieldClaims(flags, caseRecord) {
  const kept = [];
  const dropped = [];

  for (const flag of flags || []) {
    const type = String(flag?.type || '').trim().toUpperCase();
    const field = structuredFieldOf(flag?.element);
    const claimsSilence = NARRATIVE_SILENCE.test(
      [collapse(flag?.quote), collapse(flag?.reason)].join(' ')
    );

    if (
      (type === 'INCONSISTENT' || type === 'UNCLEAR') &&
      field &&
      !isEmptyValue(collapse(caseRecord?.[field])) &&
      claimsSilence
    ) {
      dropped.push(flag);
      continue;
    }
    kept.push(flag);
  }

  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// A2. Confidence floor.
// ---------------------------------------------------------------------------

export function dropLowConfidenceFlags(flags) {
  const kept = [];
  const dropped = [];
  let lowConfidenceCritical = false;

  for (const flag of flags || []) {
    const raw = flag?.confidence;
    const confidence = raw === undefined || raw === null || raw === '' ? 1 : Number(raw);
    if (Number.isFinite(confidence) && confidence < MIN_CONFIDENCE) {
      dropped.push(flag);
      if (flag?.severity === 'Critical') lowConfidenceCritical = true;
      continue;
    }
    kept.push(flag);
  }

  return { kept, dropped, lowConfidenceCritical };
}

// ---------------------------------------------------------------------------
// A3. Duplicate merging: one flag per issue.
// Flags are grouped by what they are about, not by their type or source: the same
// element (dateOfEntry, the charge, ...), or, for a flag with no element of its own,
// the same sentence and issue. A group keeps one flag with the highest severity,
// every source listed, and the clearest reason with repeated sentences removed.
// Two standing exceptions: the Critical 1326 prior-removal flag is never merged
// with anything, and an approximate date of entry stays Minor.
// ---------------------------------------------------------------------------

const GENERIC_ELEMENT = /^(|narrative|unnamed element|human review|reviewer disagreement|requires officer review)$/;

// The field a flag is about, in one canonical spelling: this is its merge topic.
function fieldTopic(name) {
  const value = norm(name).replace(/[^a-z0-9]/g, '');
  if (!value) return '';
  if (value.indexOf('dateofentry') !== -1) return 'dateofentry';
  if (value.indexOf('mannerofentry') !== -1) return 'mannerofentry';
  if (value.indexOf('mannerofencounter') !== -1) return 'mannerofencounter';
  if (value.indexOf('priorremoval') !== -1) return 'priorremoval';
  if (value.indexOf('placeofentry') !== -1) return 'placeofentry';
  if (value.indexOf('encounterdate') !== -1) return 'encounterdate';
  if (value.indexOf('encountertime') !== -1) return 'encountertime';
  if (value.indexOf('selectedcharge') !== -1) return 'charge';
  return '';
}

function topicFromText(text) {
  const value = norm(text);
  if (/1326|276|prior removal/.test(value)) return 'priorremoval';
  if (/date of entry|dateofentry/.test(value)) return 'dateofentry';
  if (/manner of entry|mannerofentry/.test(value)) return 'mannerofentry';
  if (/manner of encounter|mannerofencounter/.test(value)) return 'mannerofencounter';
  if (/place of entry|placeofentry/.test(value)) return 'placeofentry';
  if (/charge|citation|provision|usc|ina\b/.test(value)) return 'charge';
  return '';
}

function topicOf(flag) {
  const element = collapse(flag?.element);
  const elementTopic = fieldTopic(element);
  const textField = fieldForReason([collapse(flag?.quote), collapse(flag?.reason)].join(' '));
  const textTopic = textField === 'narrative' ? '' : fieldTopic(textField);

  // A reason that names a different field than the element does means the flag is
  // mislabelled (a date-of-entry problem filed under mannerOfEntry). The reason says
  // what the flag is actually about, so that is the issue it is grouped under.
  if (textTopic && textTopic !== elementTopic) return textTopic;
  if (elementTopic) return elementTopic;

  if (GENERIC_ELEMENT.test(norm(element))) {
    const derived = topicFromText(
      [element, collapse(flag?.quote), collapse(flag?.reason)].join(' ')
    );
    if (derived) return derived;
    return 'sentence:' + norm(flag?.source);
  }
  return 'element:' + norm(element);
}

function isProtectedPriorRemovalFlag(flag) {
  const text = [collapse(flag?.element), collapse(flag?.reason)].join(' ');
  return (
    String(flag?.type || '').toUpperCase() === 'CITATION' &&
    flag?.severity === 'Critical' &&
    /prior removal|1326/.test(norm(text))
  );
}

function reasonSentences(text) {
  const value = collapse(text);
  if (!value) return [];
  return (value.match(/[^.!?]+[.!?]?/g) || []).map((part) => collapse(part)).filter(Boolean);
}

function uniqueReason(reasons) {
  const out = [];
  const seen = new Set();
  for (const reason of reasons || []) {
    for (const sentence of reasonSentences(reason)) {
      const key = norm(sentence).replace(/[^a-z0-9]+/g, ' ');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(sentence);
    }
  }
  return out.join(' ');
}

function displaySource(source) {
  const value = collapse(source);
  if (!value) return '';
  if (/^s\s*\d+$/i.test(value)) return 'S' + value.replace(/\D/g, '');
  if (/^narrative$/i.test(value)) return 'narrative';
  // "dateOfEntry" and "dateOfEntry field" are the same source, so both render once.
  return value.replace(/\s+field$/i, '') + ' field';
}

function sourceList(group) {
  const sentences = [];
  const others = [];

  for (const flag of group || []) {
    for (const part of String(collapse(flag?.source)).split(/[,;]/)) {
      const label = displaySource(part);
      if (!label) continue;
      if (/^S\d+$/.test(label)) {
        if (!sentences.includes(label)) sentences.push(label);
      } else if (!others.includes(label)) {
        others.push(label);
      }
    }
  }

  const rank = (label) => Number(String(label).replace(/\D/g, '')) || 0;
  return [...sentences.sort((a, b) => rank(a) - rank(b)), ...others].join(', ');
}

function mergeGroup(topic, group) {
  const strongest = group.reduce((best, current) =>
    (SEVERITY_RANK[current?.severity] || 0) > (SEVERITY_RANK[best?.severity] || 0) ? current : best
  );

  const approximateEntry =
    topic === 'dateofentry' &&
    group.some((flag) =>
      APPROXIMATE_ENTRY_TIME.test([collapse(flag?.quote), collapse(flag?.reason)].join(' '))
    );

  const reasons = group.map((flag) => collapse(flag?.reason)).filter(Boolean);
  const clearest = reasons.slice().sort((a, b) => b.length - a.length)[0] || '';
  const quote =
    collapse(strongest?.quote) ||
    group.map((flag) => flag?.quote).find((value) => collapse(value)) ||
    '';
  const element =
    collapse(strongest?.element) ||
    group.map((flag) => collapse(flag?.element)).find(Boolean) ||
    '';

  return {
    ...strongest,
    type: approximateEntry ? 'UNCLEAR' : strongest?.type,
    severity: approximateEntry ? 'Minor' : strongest?.severity,
    element,
    source: sourceList(group) || collapse(strongest?.source),
    quote,
    confidence: Math.max(...group.map((flag) => Number(flag?.confidence) || 1)),
    reason: approximateEntry ? clearest : uniqueReason(reasons)
  };
}

export function mergeDuplicateFlags(flags) {
  const order = [];
  const groups = new Map();

  for (const flag of flags || []) {
    if (!flag) continue;
    // The 1326 contradiction is kept exactly as the code check wrote it: folding it
    // into another flag would bury the one fact the charge depends on.
    const key = isProtectedPriorRemovalFlag(flag) ? 'protected:' + order.length : topicOf(flag);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(flag);
  }

  const merged = [];
  let mergedCount = 0;

  for (const key of order) {
    const group = groups.get(key);
    if (group.length === 1 || String(key).indexOf('protected:') === 0) {
      merged.push(...group);
      continue;
    }
    mergedCount += group.length - 1;
    merged.push(mergeGroup(key, group));
  }

  return { flags: merged, mergedCount };
}

// ---------------------------------------------------------------------------
// A3b. Manner of encounter is not manner of entry.
// The encounter is how the officer came upon the subject (a passenger at a
// checkpoint, a traffic stop); the entry is how the subject crossed the border.
// A flag that treats one as contradicting the other is wrong and is dropped.
// ---------------------------------------------------------------------------

const ENTRY_CUE = /(manner of entry|entered|crossed|crossing|on foot|without inspection|swam|waded)/i;
const ENCOUNTER_CUE =
  /(manner of encounter|encounter(?:ed|ing|s)?|checkpoint|secondary inspection|traffic stop|line watch|on duty|apprehended|detained|passenger)/i;

export function isMannerConfusion(text) {
  const value = collapse(text);
  if (!value) return false;
  return ENTRY_CUE.test(value) && ENCOUNTER_CUE.test(value);
}

export function dropMannerConfusionFlags(flags) {
  const kept = [];
  const dropped = [];

  for (const flag of flags || []) {
    const element = collapse(flag?.element);
    const text = [element, collapse(flag?.quote), collapse(flag?.reason)].join(' ');
    const aboutManner = /manner|entr|encounter/i.test(element);
    if (flag?.type === 'INCONSISTENT' && aboutManner && isMannerConfusion(text)) dropped.push(flag);
    else kept.push(flag);
  }

  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// A4. Deterministic cross-checks. Added flags carry their own source and quote,
// so they never depend on the model to be traceable.
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

const MONTH_PATTERN =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

function parseNarrativeDates(text) {
  const source = collapse(text);
  const found = [];
  const seen = new Set();
  const add = (raw, month, day, year) => {
    if (!month || !day || !year) return;
    const iso = String(year) + '-' + pad(month) + '-' + pad(day);
    const key = iso + '@' + raw;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ raw, iso });
  };

  for (const match of source.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    add(match[0], Number(match[2]), Number(match[3]), match[1]);
  }
  for (const match of source.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    add(match[0], Number(match[1]), Number(match[2]), match[3]);
  }
  for (const match of source.matchAll(new RegExp('\\b(' + MONTH_PATTERN + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b', 'gi'))) {
    add(match[0], MONTHS[norm(match[1])], Number(match[2]), match[3]);
  }
  for (const match of source.matchAll(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTH_PATTERN + ')\\.?\\s+(\\d{4})\\b', 'gi'))) {
    add(match[0], MONTHS[norm(match[2])], Number(match[1]), match[3]);
  }

  return found;
}

function toIsoDate(value) {
  const text = collapse(value);
  if (!text) return '';
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  const parsed = parseNarrativeDates(text)[0];
  return parsed ? parsed.iso : '';
}

function parseNarrativeTimes(text) {
  const source = collapse(text);
  const found = [];

  for (const match of source.matchAll(/\b(\d{1,2}):(\d{2})\s*([ap]\.?\s?m\.?)?/gi)) {
    let hour = Number(match[1]);
    const minutes = Number(match[2]);
    const suffix = collapse(match[3]).toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    if (hour <= 24 && minutes < 60) found.push({ raw: match[0].trim(), minutes: hour * 60 + minutes });
  }
  for (const match of source.matchAll(/\b(\d{3,4})\s*(?:hours|hrs)\b/gi)) {
    const digits = match[1];
    const hour = Number(digits.slice(0, digits.length - 2));
    const minutes = Number(digits.slice(-2));
    if (hour <= 24 && minutes < 60) found.push({ raw: match[0].trim(), minutes: hour * 60 + minutes });
  }

  return found;
}

function fieldMinutes(value) {
  const text = collapse(value);
  if (!text) return null;
  const times = parseNarrativeTimes(text);
  if (times.length > 0) return times[0].minutes;
  const bare = text.match(/^(\d{1,2}):?(\d{2})$/);
  if (!bare) return null;
  const hour = Number(bare[1]);
  const minutes = Number(bare[2]);
  return hour <= 24 && minutes < 60 ? hour * 60 + minutes : null;
}

const ENCOUNTER_WORDS = /\b(encounter(?:ed)?|inspection|inspected|observed|on duty|line watch|apprehended|detained|detention)\b/i;
const FIRST_PERSON = /\b(I|officer)\b/;

// The encounter line is the first-person sentence that records the encounter.
// Only that line is measured against encounterDate and encounterTime: other
// dates in the narrative belong to other events (entry, birth, removals).
function encounterConsistencyFlags(caseRecord, sentences) {
  const flags = [];
  const encounterDate = toIsoDate(caseRecord?.encounterDate);
  const entryDate = toIsoDate(caseRecord?.dateOfEntry);
  const encounterTime = fieldMinutes(caseRecord?.encounterTime);

  for (const sentence of sentences || []) {
    const text = collapse(sentence?.text);
    if (!text || !ENCOUNTER_WORDS.test(text) || !FIRST_PERSON.test(text)) continue;

    const label = collapse(sentence?.label) || 'narrative';

    if (encounterDate) {
      const date = parseNarrativeDates(text).find(
        (entry) => entry.iso !== encounterDate && entry.iso !== entryDate
      );
      if (date) {
        flags.push({
          type: 'INCONSISTENT',
          element: 'encounterDate',
          source: label,
          quote: date.raw,
          reason:
            'The narrative gives ' + date.raw + ' for the encounter, but the encounterDate field records ' +
            collapse(caseRecord.encounterDate) + '. Confirm which date the record should carry.',
          severity: 'Major',
          confidence: 1
        });
      }
    }

    if (encounterTime !== null) {
      const time = parseNarrativeTimes(text)[0];
      if (time && time.minutes !== encounterTime) {
        flags.push({
          type: 'INCONSISTENT',
          element: 'encounterTime',
          source: label,
          quote: time.raw,
          reason:
            'The narrative gives ' + time.raw + ' for the encounter, but the encounterTime field records ' +
            collapse(caseRecord.encounterTime) + '. Confirm which time the record should carry.',
          severity: 'Major',
          confidence: 1
        });
      }
    }
  }

  return flags;
}

const CITATION_PATTERNS = [
  /(?:8\s*U\.?\s*S\.?\s*C\.?|INA|I\.?\s?N\.?\s?A\.?|Immigration and Nationality Act)\s*(?:section|sec\.?|§)?\s*(\d{3,4}(?:\([0-9a-zA-Z]+\))*)/gi,
  /(?:section|sec\.?|§)\s*(\d{3,4}(?:\([0-9a-zA-Z]+\))*)\s+of\s+the\s+(?:INA|Immigration and Nationality Act)/gi
];

function findNarrativeCitations(text) {
  const source = collapse(text);
  const found = [];
  for (const pattern of CITATION_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push({ raw: collapse(match[0]), value: match[1] });
  }
  return found;
}

// The section number is what the crosswalk settles; subparagraphs are not
// compared, so 8 USC 1325 and INA 275(a) read as the same provision.
function sectionOf(value) {
  const match = String(value || '').match(/(\d{3,4})/);
  if (!match) return '';
  return INA_TO_USC[match[1]] || match[1];
}

// One flag per sentence, with one sentence of reason per provision cited, so the
// charge mismatch is never written out twice for the citations in one sentence.
function crosswalkFlags(caseRecord, sentences) {
  const selectedSection = sectionOf(caseRecord?.selectedCharge);
  if (!selectedSection) return [];

  const selectedText = collapse(caseRecord?.selectedCharge);
  const flags = [];

  for (const sentence of sentences || []) {
    const cited = [];
    const seen = new Set();

    for (const citation of findNarrativeCitations(sentence?.text)) {
      if (sectionOf(citation.value) === selectedSection) continue;
      const value = collapse(citation.raw);
      const key = norm(value).replace(/[^a-z0-9]+/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cited.push(value);
    }
    if (cited.length === 0) continue;

    const label = collapse(sentence?.label) || 'narrative';
    flags.push({
      type: 'CITATION',
      element: 'selectedCharge',
      source: label,
      quote: cited[0],
      reason:
        cited.map((value) => 'The narrative cites ' + value + ' at ' + label + '.').join(' ') +
        ' The selectedCharge field records ' +
        selectedText +
        ', and only the officer decides which citation the record supports.',
      severity: 'Major',
      confidence: 1
    });
  }

  return flags;
}

const RIGHTS_MENTION =
  /(miranda|advised[^.]{0,60}rights|rights[^.]{0,40}(?:advis|read|explain)|acknowledged[^.]{0,40}rights|understood[^.]{0,30}rights)/i;

function rightsAdvisementFlags(caseRecord) {
  const section = sectionOf(caseRecord?.selectedCharge);
  if (section !== '1325' && section !== '1326') return [];

  const record = [collapse(caseRecord?.narrative), collapse(caseRecord?.subjectStatements)].join('\n');
  if (RIGHTS_MENTION.test(record)) return [];

  return [
    {
      type: 'MISSING',
      element: 'Rights advisement',
      source: 'narrative',
      quote: '',
      reason:
        'The record cites a criminal provision (8 USC ' + section +
        ') but nowhere states that the subject was advised of their rights. Document the advisement, or explain why none was given.',
      severity: 'Major',
      confidence: 1
    }
  ];
}

const REMOVAL_MENTION = /(remov|deport|reinstate|expedited removal|voluntary departure|exclusion|barred)/i;
const NONE_VALUES =
  /^(?:none|no|n\/a|na|unknown|unclear|none recorded|none known|none reported|no prior removals?|no removals?|not provided|\(not provided\)|-+|\.)$/i;

function isEmptyValue(value) {
  const text = collapse(value).replace(/[.\s]+$/, '');
  return !text || NONE_VALUES.test(text);
}

function isPriorRemovalCharge(charge) {
  const text = collapse(charge);
  if (!text) return false;
  if (sectionOf(text) === '1326') return true;
  return /212\s*\(\s*a\s*\)\s*\(\s*9\s*\)/i.test(text);
}

function priorRemovalFlags(caseRecord) {
  if (!isPriorRemovalCharge(caseRecord?.selectedCharge)) return [];

  const mentioned = REMOVAL_MENTION.test(
    [
      collapse(caseRecord?.narrative),
      collapse(caseRecord?.immigrationHistory),
      collapse(caseRecord?.subjectStatements),
      collapse(caseRecord?.priorRemovals)
    ].join('\n')
  );
  if (mentioned) return [];

  return [
    {
      type: 'MISSING',
      element: 'Prior removal',
      source: 'priorRemovals',
      quote: '',
      reason:
        'The selected charge rests on a prior removal. The priorRemovals field carries nothing and the narrative does not mention a removal, so the record does not hold the fact the charge depends on.',
      severity: 'Critical',
      confidence: 1
    }
  ];
}

// A narrative that leans on 1326 needs a documented prior removal. 1326 (INA 276)
// punishes re-entry after a removal, so a record that cites it while saying there
// was no prior removal contradicts itself.
const MENTIONS_1326 =
  /(?:8\s*U\.?\s*S\.?\s*C\.?\s*(?:section\s*)?1326\b|INA\s*(?:section|sec\.?)?\s*276\b|section\s*276\s+of\s+the\s+INA|276\s*\(\s*a\s*\))/i;

const NO_PRIOR_REMOVAL =
  /(no prior removals?|no removals?|never (?:been )?removed|not (?:been )?removed|no record of (?:a |any )?removal|no prior deport|no prior immigration proceedings|no immigration proceedings|no prior removal proceedings)/i;

const APPROXIMATE_ENTRY_TIME =
  /(?:(?:about|approximately|approx\.?|around|roughly|nearly|some|a few|several|many)\s+)?(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of)\s+)?(?:years?|months?|weeks?|days?|decades?)\s+(?:ago|earlier|before|prior)\b/i;

function mentions1326(text) {
  const value = collapse(text);
  if (!value) return false;
  if (MENTIONS_1326.test(value)) return true;
  return findNarrativeCitations(value).some((citation) => sectionOf(citation.value) === '1326');
}

function firstMentionOf1326(text) {
  const value = collapse(text);
  const match = value.match(MENTIONS_1326);
  if (match) return collapse(match[0]);
  const found = findNarrativeCitations(value).find((citation) => sectionOf(citation.value) === '1326');
  return found ? found.raw : '';
}

function priorRemovalEvidenceFlags(caseRecord, sentences) {
  const hit = (sentences || []).find((sentence) => mentions1326(sentence?.text));
  if (!mentions1326(caseRecord?.selectedCharge) && !hit && !mentions1326(caseRecord?.narrative)) {
    return [];
  }

  const record = [
    collapse(caseRecord?.narrative),
    collapse(caseRecord?.immigrationHistory),
    collapse(caseRecord?.subjectStatements),
    collapse(caseRecord?.priorRemovals)
  ].join('\n');

  const saysNone = NO_PRIOR_REMOVAL.test(record);
  if (!saysNone && !isEmptyValue(caseRecord?.priorRemovals)) return [];

  const source = hit ? collapse(hit.label) || 'narrative' : 'selectedCharge';
  const quote = hit ? firstMentionOf1326(hit.text) : collapse(caseRecord?.selectedCharge);

  return [
    {
      type: 'CITATION',
      element: 'Prior removal',
      source,
      quote,
      reason:
        '1326 requires a prior removal, but the record says there is none.' +
        (saysNone
          ? ' The narrative states there is no prior removal or no prior immigration proceedings.'
          : ' The priorRemovals field is empty.') +
        ' Document the removal the record relies on, or the officer confirms which provision the record supports.',
      severity: 'Critical',
      confidence: 1
    }
  ];
}

// The date of entry has to be established. An approximate time ("three years
// ago") does not establish it, so it is flagged as unclear rather than missing.
export function approximateEntryPhrase(sentences) {
  for (const sentence of sentences || []) {
    const match = collapse(sentence?.text).match(APPROXIMATE_ENTRY_TIME);
    if (match) return collapse(match[0]);
  }
  return '';
}

// The one wording used for the date of entry, by the code check and by the routing
// reason alike: an approximate time is not a discrepancy, the date is not established.
export function dateOfEntryReason(caseRecord, sentences) {
  const phrase = approximateEntryPhrase(sentences);
  const field = collapse(caseRecord?.dateOfEntry);
  const fieldClause = field
    ? 'the dateOfEntry field records "' + field + '"'
    : 'the dateOfEntry field is empty';

  return phrase
    ? 'The exact date of entry is not established: ' + fieldClause +
      ' and the narrative gives only an approximate time ("' + phrase + '").'
    : 'The exact date of entry is not established: ' + fieldClause +
      ' and the narrative gives no date.';
}

function entryDateFlags(caseRecord, sentences) {
  const field = collapse(caseRecord?.dateOfEntry);
  if (/^\d{4}-\d{2}-\d{2}/.test(field)) return [];

  const phrase = approximateEntryPhrase(sentences);
  const hit = phrase
    ? (sentences || []).find((sentence) => collapse(sentence?.text).indexOf(phrase) !== -1)
    : null;

  return [
    {
      type: 'UNCLEAR',
      element: 'dateOfEntry',
      source: hit ? collapse(hit.label) || 'narrative' : 'dateOfEntry',
      quote: phrase,
      reason: dateOfEntryReason(caseRecord, sentences),
      severity: 'Minor',
      confidence: 1
    }
  ];
}

export function deterministicFlags(caseRecord, sentences) {
  return [
    ...encounterConsistencyFlags(caseRecord, sentences),
    ...crosswalkFlags(caseRecord, sentences),
    ...rightsAdvisementFlags(caseRecord),
    ...priorRemovalFlags(caseRecord),
    ...priorRemovalEvidenceFlags(caseRecord, sentences),
    ...entryDateFlags(caseRecord, sentences)
  ];
}

// ---------------------------------------------------------------------------
// C. Ambiguity and contradiction reasons, decided in code.
// ---------------------------------------------------------------------------

function removalSentenceHasDate(sentences) {
  for (const sentence of sentences || []) {
    const text = collapse(sentence?.text);
    if (text && REMOVAL_MENTION.test(text) && parseNarrativeDates(text).length > 0) return true;
  }
  return false;
}

// Pins a free-text reason to the field it names, so the flag it becomes points
// somewhere the officer can open.
const FIELD_HINTS = [
  ['dateOfEntry', 'date of entry'],
  ['mannerOfEntry', 'manner of entry'],
  ['mannerOfEncounter', 'manner of encounter'],
  ['priorRemovals', 'prior removal'],
  ['placeOfEntry', 'place of entry'],
  ['encounterDate', 'encounter date'],
  ['encounterTime', 'encounter time'],
  ['documentsPresented', 'document'],
  ['subjectStatements', 'statement'],
  ['immigrationHistory', 'immigration history'],
  ['citizenship', 'citizenship'],
  ['subjectName', 'name'],
  ['selectedCharge', 'charge']
];

export function fieldForReason(text) {
  const value = norm(text);
  // A field named outright ("dateOfEntry") wins over a phrase that merely describes
  // it ("date of entry").
  for (const [field] of FIELD_HINTS) {
    if (value.indexOf(norm(field)) !== -1) return field;
  }
  for (const [field, hint] of FIELD_HINTS) {
    if (value.includes(hint)) return field;
  }
  return 'narrative';
}

// Each ambiguity reason comes with the flag that carries it into the report.
export function ambiguityEntries(caseRecord, sentences) {
  const entries = [];
  const narrative = collapse(caseRecord?.narrative);

  const removalMentioned = REMOVAL_MENTION.test(
    [
      narrative,
      collapse(caseRecord?.immigrationHistory),
      collapse(caseRecord?.subjectStatements),
      collapse(caseRecord?.priorRemovals)
    ].join('\n')
  );
  if (removalMentioned) {
    const notes = [];
    if (
      !removalSentenceHasDate(sentences) &&
      parseNarrativeDates(caseRecord?.priorRemovals).length === 0
    ) {
      notes.push('no date');
    }
    if (isEmptyValue(caseRecord?.priorRemovals)) notes.push('no removal record');
    if (notes.length > 0) {
      const text =
        'A prior removal is mentioned with ' + notes.join(' and ') +
        ', so the facts could fit more than one provision in the reference library.';
      const sentence = (sentences || []).find((item) => REMOVAL_MENTION.test(collapse(item?.text)));
      entries.push({
        text,
        flags: [
          {
            type: 'UNCLEAR',
            element: 'Prior removal',
            source: sentence ? collapse(sentence.label) || 'narrative' : 'priorRemovals',
            quote: sentence ? collapse(sentence.text) : '',
            reason: text,
            severity: 'Major',
            confidence: 1
          }
        ]
      });
    }
  }

  const manner = collapse(caseRecord?.mannerOfEntry);
  const VAGUE_MANNER = /^(?:unknown|unclear|n\/a|none|not provided|not known|undetermined|\(not provided\))$/i;
  const VAGUE_NARRATIVE =
    /(unknown manner|manner of entry is unclear|manner of entry unknown|at some point|at an unknown time|unclear how|does not recall how|no recollection of how|it is unclear how)/i;

  if (!manner || VAGUE_MANNER.test(manner) || VAGUE_NARRATIVE.test(narrative)) {
    const text =
      'The manner of entry is unclear, so the facts could fit more than one provision in the reference library.';
    const sentence = (sentences || []).find((item) => VAGUE_NARRATIVE.test(collapse(item?.text)));
    entries.push({
      text,
      flags: [
        {
          type: 'UNCLEAR',
          element: 'mannerOfEntry',
          source: sentence ? collapse(sentence.label) || 'narrative' : 'mannerOfEntry',
          quote: sentence ? collapse(sentence.text) : VAGUE_MANNER.test(manner) ? collapse(manner) : '',
          reason: text,
          severity: 'Major',
          confidence: 1
        }
      ]
    });
  }

  return entries;
}

export function contradictionReasons(flags) {
  const byElement = new Map();
  for (const flag of flags || []) {
    if (flag?.severity !== 'Critical') continue;
    const key = norm(flag?.element) || norm(flag?.source);
    if (!byElement.has(key)) byElement.set(key, []);
    byElement.get(key).push(flag);
  }

  const reasons = [];
  for (const group of byElement.values()) {
    const missing = group.find((flag) => flag?.type === 'MISSING');
    const stated = group.find((flag) => flag?.type !== 'MISSING');
    if (missing && stated) {
      reasons.push(
        'Two critical flags about "' + (missing.element || missing.source) +
        '" contradict each other: one says it is missing, the other says it is stated but inconsistent.'
      );
    }
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// C2. Routing reasons, each paired with the flag that carries it into the report.
// A case is never sent to human review with an empty gap list: every reason below
// is either covered by a flag already in the report or arrives with its own flag,
// tied to the sentence or field it came from.
// ---------------------------------------------------------------------------

export function routingEntries(params) {
  const input = params || {};
  const flags = input.flags || [];
  const sentences = input.sentences || [];
  const citationCheck = input.citationCheck || {};
  const caseRecord = input.caseRecord || {};
  const entries = [];
  const seen = new Set();

  // A flag about the record has to quote the wording it rests on. One that carries no
  // quote is dropped here as unverified, and the reason that came with it goes too.
  const unverified = [];

  const push = (text, paired) => {
    const value = collapse(text);
    if (!value || seen.has(value)) return;
    const claims = (paired || []).filter(Boolean);
    const usable = claims.filter((flag) => {
      if (String(flag?.type || '').trim().toUpperCase() === 'MISSING') return true;
      if (collapse(flag?.quote)) return true;
      // Entries about the review itself ("the two passes disagree") have no record
      // wording to quote; an entry about a field does, so it cannot stand without one.
      return !structuredFieldOf(flag?.element);
    });
    if (claims.length > 0 && usable.length === 0) return;
    claims.forEach((flag) => {
      if (!usable.includes(flag)) unverified.push(flag);
    });
    seen.add(value);
    entries.push({ text: value, flags: usable });
  };

  // The reviewer's own reasons, pinned to the field each one names. A reason that
  // only restates the manner-of-entry / manner-of-encounter confusion is not a real
  // problem, so it is dropped instead of being turned into a flag.
  for (const reason of input.modelReasons || []) {
    let value = collapse(reason);
    if (!value || isMannerConfusion(value)) continue;
    const field = fieldForReason(value);
    // An approximate date of entry is not a "discrepancy": it is a date that was
    // never established, and the reason says so in the words the flag uses.
    if (field === 'dateOfEntry') value = dateOfEntryReason(caseRecord, sentences);
    const flag = {
      type: 'UNCLEAR',
      element: field,
      source: field,
      quote: '',
      reason: value,
      severity: field === 'dateOfEntry' ? 'Minor' : 'Major',
      confidence: 1
    };
    // When the report already carries a flag on the same issue, the reason points at
    // it instead of adding a second, quote-less copy of the same problem.
    const covered = flags.some((existing) => existing && topicOf(existing) === topicOf(flag));
    push(value, covered ? [] : [flag]);
  }

  const criticalCount = flags.filter((flag) => flag && flag.severity === 'Critical').length;
  if (criticalCount > 0) {
    push(criticalCount + ' critical problem(s) were flagged against this record.', []);
  }

  const citationFlagExists = flags.some((flag) => flag && flag.type === 'CITATION');
  if (citationCheck.status === 'LIKELY MISMATCH') {
    const text = 'The charge as written could not be confirmed against the facts in the record.';
    push(
      text,
      citationFlagExists
        ? []
        : [
            {
              type: 'CITATION',
              element: 'selectedCharge',
              source: 'selectedCharge',
              quote: collapse(caseRecord.selectedCharge),
              reason: text + (citationCheck.reason ? ' ' + collapse(citationCheck.reason) : ''),
              severity: 'Major',
              confidence: 1
            }
          ]
    );
  }
  if (citationCheck.status === 'CANNOT DETERMINE' && collapse(caseRecord.selectedCharge)) {
    const text =
      'The citation check could not determine whether the charge as written is supported.';
    push(
      text,
      citationFlagExists
        ? []
        : [
            {
              type: 'CITATION',
              element: 'selectedCharge',
              source: 'selectedCharge',
              quote: collapse(caseRecord.selectedCharge),
              reason: text,
              severity: 'Minor',
              confidence: 1
            }
          ]
    );
  }
  if (!collapse(caseRecord.selectedCharge)) {
    const text = 'No charge is recorded on this case. The officer selects the charge.';
    push(text, [
      {
        type: 'MISSING',
        element: 'selectedCharge',
        source: 'selectedCharge',
        quote: '',
        reason: text,
        severity: 'Major',
        confidence: 1
      }
    ]);
  }

  // The narrative names a provision other than the one on the file: the code check
  // already put the Major CITATION flag on that sentence, so the reason points at it.
  const narrativeNamesOtherCharge = flags.some(
    (flag) =>
      flag &&
      flag.type === 'CITATION' &&
      norm(flag.element) === 'selectedcharge' &&
      norm(flag.source) !== 'selectedcharge'
  );
  if (narrativeNamesOtherCharge) {
    push(
      'The narrative names a provision other than the charge on the file, so an officer must confirm which provision the record supports.',
      []
    );
  }

  for (const entry of ambiguityEntries(caseRecord, sentences)) {
    push(entry.text, entry.flags);
  }

  if (input.lowConfidenceCritical) {
    const droppedCritical = (input.droppedFlags || []).filter(
      (flag) => flag && flag.severity === 'Critical'
    );
    const text =
      'A critical flag fell below the confidence floor, so the checks disagree and an officer must settle it.';
    push(
      text,
      droppedCritical.map((flag) => ({
        ...flag,
        severity: 'Minor',
        reason: text + ' ' + collapse(flag.reason)
      }))
    );
  }

  for (const reason of contradictionReasons(flags)) push(reason, []);

  const rejectedCritical = (input.rejectedFlags || []).filter(
    (flag) => flag && flag.severity === 'Critical'
  );
  if (rejectedCritical.length > 0) {
    const text =
      'The second reviewer rejected ' + rejectedCritical.length +
      ' critical flag(s), so the two passes disagree and an officer must settle it.';
    push(text, [
      {
        type: 'UNCLEAR',
        element: 'Reviewer disagreement',
        source: 'narrative',
        quote: '',
        reason: text,
        severity: 'Major',
        confidence: 1
      }
    ]);
  }

  if (entries.length === 0 && input.modelNeeded) {
    const text = 'The reviewer asked for human review but did not name the problem.';
    push(text, [
      {
        type: 'UNCLEAR',
        element: 'narrative',
        source: 'narrative',
        quote: '',
        reason: text,
        severity: 'Major',
        confidence: 1
      }
    ]);
  }

  return { entries, unverified };
}

// ---------------------------------------------------------------------------
// B. Verifier pass: the second, skeptical reviewer.
// ---------------------------------------------------------------------------

const VERIFIER_INSTRUCTION =
  'For each flag, act as a skeptical second reviewer. Reject a flag ONLY when the record itself shows the element is present and correct: then evidence must quote the exact sentence text or field value that establishes it. If you cannot point to that evidence, do not reject. Answer downgrade when the flag is overstated or you are unsure of it: it stays in the report at Minor for the officer to settle. Answer keep when the flag is accurate as written. An empty structured field, an approximate time such as "three years ago", or a vague statement is not proof that the element is documented: if it is still not reliably recorded, keep or downgrade the flag. Only the officer decides the charge and writes the narrative.';

export const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: ['keep', 'downgrade', 'reject'] },
          reason: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['id', 'decision', 'reason']
      }
    }
  },
  required: ['verdicts']
};

export function buildVerifierPrompt(caseRecord, sentences, flags) {
  const sentenceBlock = (sentences || [])
    .map((sentence) => (sentence.label || '') + ': ' + (sentence.text || ''))
    .join('\n');

  const flagBlock = (flags || [])
    .map((flag, index) =>
      'F' + (index + 1) +
      '. type=' + (flag?.type || '') +
      ' | severity=' + (flag?.severity || '') +
      ' | element=' + (flag?.element || '') +
      ' | source=' + (flag?.source || '') +
      ' | quote="' + (flag?.quote || '') + '"' +
      ' | reason=' + (flag?.reason || '')
    )
    .join('\n');

  return [
    VERIFIER_INSTRUCTION,
    'Answer with one verdict per flag id (F1, F2, ...), using keep, downgrade or reject. A reject must quote in evidence the record text that shows the element is present and correct; a reject without that quote is treated as a downgrade.',
    '',
    '=== NUMBERED SENTENCES OF THE OFFICER-WRITTEN NARRATIVE (read-only) ===',
    sentenceBlock || '(no narrative entered)',
    '',
    '=== STRUCTURED FIELDS (the exact field names used as flag sources) ===',
    caseFieldBlock(caseRecord),
    '',
    '=== FLAGS TO VERIFY ===',
    flagBlock || '(no flags)'
  ].join('\n');
}