// The reviewer pass, in one place.
//
// runReview (the built-in reviewer) and reviewWithGptOss (the hosted gpt-oss
// endpoint) both build their request from this module, so the system instruction,
// the user content and the response schema are identical whichever model runs.

import { caseFieldBlock } from './verify.ts';

export const REVIEWER_INSTRUCTIONS = `You are a documentation quality reviewer for immigration charge narratives. You do NOT write narratives and you do NOT choose charges. Your job is to find problems the officer must fix.
Check for:
1. MISSING: a required element that is not stated anywhere in the narrative or the fields. An approximate place of entry like 'near Brownsville, TX' is complete.
2. INCONSISTENT: the narrative contradicts itself or contradicts a structured field (dates, times, names, places, counts, citizenship, citations).
3. UNCLEAR: an element is mentioned but too vague to support the record (for example 'entered at some point').
4. CITATION: the selected charge is not supported by the facts, a required fact for that charge is missing, or the citation format or INA/USC crosswalk is wrong.
Rules:
Every flag MUST include the sentence ID (like S4) or the exact field name it came from, plus an exact quote copied word for word. For a MISSING flag, use the field name or 'narrative' and quote nothing.
Give a plain-language reason a non-lawyer can understand.
Only flag real problems. If you are not confident, do not flag it; mark the case for human review instead.
The manner of ENCOUNTER (how the officer came upon the subject, such as a passenger in a vehicle at a checkpoint) is a different fact from the manner of ENTRY (how the subject crossed the border). Never treat them as conflicting with each other, and never build a flag out of comparing one with the other.
Never suggest which charge should be used instead. You may say which required fact of the selected charge is unsupported.
Set needsHumanReview to true if the facts are ambiguous, could support more than one charge, or key facts conflict in a way the officer must resolve.`;

export const REVIEWER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    extractedFacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          element: { type: 'string' },
          value: { type: 'string' },
          source: { type: 'string' }
        },
        required: ['element', 'value', 'source']
      }
    },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['MISSING', 'INCONSISTENT', 'UNCLEAR', 'CITATION'] },
          element: { type: 'string' },
          source: { type: 'string' },
          quote: { type: 'string' },
          reason: { type: 'string' },
          severity: { type: 'string', enum: ['Critical', 'Major', 'Minor'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['type', 'element', 'source', 'quote', 'reason', 'severity', 'confidence']
      }
    },
    citationCheck: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['SUPPORTED', 'LIKELY MISMATCH', 'CANNOT DETERMINE'] },
        chargeReviewed: { type: 'string' },
        requiredFactsFound: { type: 'array', items: { type: 'string' } },
        requiredFactsMissing: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' }
      },
      required: [
        'status',
        'chargeReviewed',
        'requiredFactsFound',
        'requiredFactsMissing',
        'reason'
      ]
    },
    humanReview: {
      type: 'object',
      properties: {
        needed: { type: 'boolean' },
        reasons: { type: 'array', items: { type: 'string' } }
      },
      required: ['needed', 'reasons']
    }
  },
  required: ['extractedFacts', 'flags', 'citationCheck', 'humanReview']
};

// One request, three shapes of the same thing: the built-in model takes `prompt`
// (system instruction and content joined, as it always has), a chat-completions
// endpoint takes `system` and `user` as separate messages.
export function buildReviewRequest(caseRecord, elements, chargeRef, sentences) {
  const sentenceBlock = (sentences || [])
    .map((sentence) => (sentence.label || '') + ': ' + (sentence.text || ''))
    .join('\n');

  const fieldBlock = caseFieldBlock(caseRecord);

  const elementBlock = (elements || [])
    .map((element, index) => {
      return (
        index +
        1 +
        '. [' +
        element.severity +
        '] ' +
        element.name +
        '\n' +
        '   What this means: ' +
        (element.description || '(no description)') +
        '\n' +
        '   Usually appears in: ' +
        (element.whereItUsuallyAppears || '(not specified)')
      );
    })
    .join('\n');

  const referenceBlock = chargeRef
    ? [
        'code: ' + (chargeRef.code || '(not provided)'),
        'uscCitation: ' + (chargeRef.uscCitation || '(not provided)'),
        'inaCitation: ' + (chargeRef.inaCitation || '(not provided)'),
        'plainName: ' + (chargeRef.plainName || '(not provided)'),
        'plainDescription: ' + (chargeRef.plainDescription || '(not provided)'),
        'requiredFacts:',
        '- ' + (chargeRef.requiredFacts || []).join('\n- '),
        'commonConfusions: ' + (chargeRef.commonConfusions || '(none recorded)')
      ].join('\n')
    : 'No reference-library record matches the selected charge string. Report CITATION with status CANNOT DETERMINE and set needsHumanReview to true.';

  const user = [
    '',
    '=== NUMBERED SENTENCES OF THE OFFICER-WRITTEN NARRATIVE (read-only; never write or rewrite it) ===',
    sentenceBlock || '(no narrative entered)',
    '',
    '=== STRUCTURED FIELDS (these are the exact field names; use them verbatim as the source of a flag) ===',
    fieldBlock,
    '',
    '=== SELECTED CHARGE AND ITS REFERENCE-LIBRARY RECORD ===',
    'The officer selected this charge, and only the officer may change it. The record below, including its common-confusion note, is background for the officer: never name, compare, rank, or suggest another provision, and never repeat the background note as a suggestion. Report only which required fact of the selected charge is unsupported.',
    referenceBlock,
    '',
    '=== REQUIRED ELEMENTS ===',
    elementBlock || '(required-elements list unavailable)'
  ].join('\n');

  return {
    system: REVIEWER_INSTRUCTIONS,
    user,
    prompt: REVIEWER_INSTRUCTIONS + '\n' + user
  };
}