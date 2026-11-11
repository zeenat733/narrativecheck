import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { findChargeReference } from '../../shared/citation.ts';
import { toSentenceRecords } from '../../shared/sentences.ts';
import { REVIEWER_RESPONSE_SCHEMA, buildReviewRequest } from '../../shared/reviewPrompt.ts';
import { GPT_OSS_MODEL, GPT_OSS_TIMEOUT_MS, callGptOssReviewer } from '../../shared/gptOss.ts';

// Runs the reviewer pass on the hosted Unissant gpt-oss-20b endpoint, from the same
// instruction, content and response schema the built-in reviewer uses. The caller
// passes a case id only: the prompt is built here from the case, and the API key
// stays on the server.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const caseId = body && typeof body.caseId === 'string' ? body.caseId : '';
    if (!caseId) return Response.json({ error: 'caseId is required' }, { status: 400 });

    // User-scoped read: row-level security decides whether this officer may open the case.
    const caseRecord = await base44.entities.Case.get(caseId).catch((e) =>
      e.status === 404 || e.status === 403 || e.status === 401 ? null : Promise.reject(e)
    );
    if (!caseRecord) return Response.json({ error: 'Case not found' }, { status: 404 });

    const elements = await base44.entities.RequiredElement.list();
    const chargeRefs = await base44.entities.ChargeReference.list();
    const chargeRef = findChargeReference(chargeRefs, caseRecord.selectedCharge);

    const storedSentences = Array.isArray(caseRecord.narrativeSentences)
      ? caseRecord.narrativeSentences.filter((sentence) => sentence && sentence.text)
      : [];
    const sentences =
      storedSentences.length > 0 ? storedSentences : toSentenceRecords(caseRecord.narrative);

    const request = buildReviewRequest(caseRecord, elements, chargeRef, sentences);

    const startedAt = Date.now();
    const output = await callGptOssReviewer({
      system: request.system,
      user: request.user,
      schema: REVIEWER_RESPONSE_SCHEMA
    });
    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

    return Response.json({
      model: GPT_OSS_MODEL,
      timeoutSeconds: GPT_OSS_TIMEOUT_MS / 1000,
      durationSeconds,
      output
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}