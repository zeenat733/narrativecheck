// Reviewer pass on the hosted Unissant endpoint (OpenAI-compatible chat completions).
//
// The API key is read from the CHALLENGEX_API_KEY secret inside the request, and
// never leaves the server. Only the OpenAI-compatible request is sent; the secret
// is used for nothing else.

import { secrets } from 'base44:runtime';

export const GPT_OSS_MODEL = 'gpt-oss-20b';
export const GPT_OSS_TIMEOUT_MS = 50000;

const GPT_OSS_ENDPOINT = 'https://challengex-ext2.unissantmissionworks.com/v1/chat/completions';

function jsonInstruction(schema) {
  return [
    'Reply with a single JSON object and nothing else. It must match this JSON schema exactly:',
    JSON.stringify(schema),
    'No commentary, no markdown, no code fences, no text outside the JSON object.'
  ].join('\n');
}

// Accepts a bare object, a fenced code block, or an object with text around it.
function extractJson(text) {
  const trimmed = String(text === undefined || text === null ? '' : text).trim();
  if (!trimmed) return null;

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const candidates = [unfenced];
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start > 0 || (end > -1 && end < unfenced.length - 1)) {
    if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      // try the next candidate
    }
  }
  return null;
}

async function requestOnce({ system, user, schema, timeoutMs, apiKey, correction }) {
  const content = [
    user,
    '',
    jsonInstruction(schema),
    correction ? '\nYour previous reply was not valid JSON. Reply again with the JSON object only.' : ''
  ].join('\n');

  const response = await fetch(GPT_OSS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GPT_OSS_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content }
      ],
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      'gpt-oss endpoint returned ' + response.status + (detail ? ': ' + detail.slice(0, 180) : '')
    );
  }

  const payload = await response.json();
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  const answer = message && message.content;
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error('gpt-oss endpoint returned no message content');
  }
  return answer;
}

// Returns the reviewer output as an object. One retry if the reply cannot be parsed.
export async function callGptOssReviewer({ system, user, schema, timeoutMs }) {
  const apiKey = secrets.get('CHALLENGEX_API_KEY');
  if (!apiKey) throw new Error('The CHALLENGEX_API_KEY secret is not set');

  const timeout = timeoutMs || GPT_OSS_TIMEOUT_MS;
  const shared = { system, user, schema, timeoutMs: timeout, apiKey };

  const first = await requestOnce({ ...shared, correction: false });
  const parsed = extractJson(first);
  if (parsed) return parsed;

  const second = await requestOnce({ ...shared, correction: true });
  const retried = extractJson(second);
  if (retried) return retried;

  throw new Error('gpt-oss did not return valid JSON after one retry');
}