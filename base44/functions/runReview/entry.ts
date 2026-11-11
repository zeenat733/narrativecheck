import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { findChargeReference } from '../../shared/citation.ts';
import { toSentenceRecords } from '../../shared/sentences.ts';
import {
  REVIEWER_RESPONSE_SCHEMA,
  buildReviewRequest
} from '../../shared/reviewPrompt.ts';
import { callGptOssReviewer } from '../../shared/gptOss.ts';
import {
  VERIFIER_SCHEMA,
  buildVerifierPrompt,
  deterministicFlags,
  dropSilentFieldClaims,
  dropLowConfidenceFlags,
  dropMannerConfusionFlags,
  mergeDuplicateFlags,
  routingEntries,
  verifyFlagQuotes
} from '../../shared/verify.ts';

// The reviewer instructions, the response schema and the prompt live in
// base44/shared/reviewPrompt.ts, so this function and the gpt-oss reviewer build
// the identical request from one source.

function flat(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeCitationCheck(raw, selectedCharge) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const status = ['SUPPORTED', 'LIKELY MISMATCH', 'CANNOT DETERMINE'].includes(source.status)
    ? source.status
    : 'CANNOT DETERMINE';

  return {
    status,
    chargeReviewed: source.chargeReviewed || selectedCharge || '',
    requiredFactsFound: Array.isArray(source.requiredFactsFound) ? source.requiredFactsFound : [],
    requiredFactsMissing: Array.isArray(source.requiredFactsMissing) ? source.requiredFactsMissing : [],
    reason: source.reason || ''
  };
}

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
    const sentences = storedSentences.length > 0
      ? storedSentences
      : toSentenceRecords(caseRecord.narrative);

    const reviewerRequest = buildReviewRequest(caseRecord, elements, chargeRef, sentences);

    const startedAt = Date.now();

    // Pass 1: the model reads the record and proposes flags. The officer picks the
    // model for this pass in Settings; the platform default is the fallback.
    const pass1StartedAt = Date.now();
    let reviewerRequested = 'built_in';
    let reviewerUsed = 'automatic (platform default)';
    let reviewerFallback = '';
    let parsed = null;

    if (user.reviewModel === 'gpt_oss_20b') {
      reviewerRequested = 'gpt_oss_20b';
      try {
        parsed = await callGptOssReviewer({
          system: reviewerRequest.system,
          user: reviewerRequest.user,
          schema: REVIEWER_RESPONSE_SCHEMA
        });
        reviewerUsed = 'gpt-oss-20b (Unissant endpoint)';
      } catch (gptOssError) {
        reviewerFallback = flat(
          (gptOssError && gptOssError.message) || 'the gpt-oss endpoint did not complete'
        );
      }
    }

    if (!parsed) {
      const result = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: reviewerRequest.prompt,
        response_json_schema: REVIEWER_RESPONSE_SCHEMA
      });
      parsed = result && typeof result === 'object' ? result : {};
    }
    const pass1Seconds = Math.max(1, Math.round((Date.now() - pass1StartedAt) / 1000));

    const modelUsed = reviewerFallback
      ? 'automatic (platform default) \u2014 gpt-oss-20b failed, fell back'
      : reviewerUsed;
    const extractedFacts = Array.isArray(parsed.extractedFacts) ? parsed.extractedFacts : [];
    const proposedFlags = Array.isArray(parsed.flags) ? parsed.flags : [];
    const citationCheck = normalizeCitationCheck(parsed.citationCheck, caseRecord.selectedCharge);

    // Pass 2a: code checks on the reviewer's own flags. No AI takes part here.
    // Manner of encounter and manner of entry describe different things, so a flag
    // that treats one as contradicting the other is dropped before anything else.
    const mannerCheck = dropMannerConfusionFlags(proposedFlags);
    const quoteCheck = verifyFlagQuotes(mannerCheck.kept, caseRecord, sentences);
    // A field the narrative never mentions cannot be inconsistent with it: at most it
    // is one Minor gap saying the fields state it and the narrative does not.
    const silentFieldCheck = dropSilentFieldClaims(quoteCheck.kept, caseRecord);
    const confidenceCheck = dropLowConfidenceFlags(silentFieldCheck.kept);
    const candidateMerge = mergeDuplicateFlags(confidenceCheck.kept);
    const modelFlags = candidateMerge.flags;

    // Checks against the record itself. These are facts read off the record, not
    // opinions, so they never go to the verifier; they join the report after it.
    const codeFlags = deterministicFlags(caseRecord, sentences);

    // Pass 2b: a second model pass judges the reviewer's flags. It can keep a flag,
    // lower it to Minor, or reject it — and a rejection only stands when the verdict
    // quotes the record text that settles the flag. A doubt never deletes a flag.
    const verifierStartedAt = Date.now();
    let verifierOutput = null;
    let verifierError = '';
    if (modelFlags.length > 0) {
      try {
        verifierOutput = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: buildVerifierPrompt(caseRecord, sentences, modelFlags),
          response_json_schema: VERIFIER_SCHEMA
        });
      } catch (error) {
        verifierError = (error && error.message) || 'The verifier pass did not complete.';
      }
    }
    const verifierSeconds = modelFlags.length > 0
      ? Math.max(1, Math.round((Date.now() - verifierStartedAt) / 1000))
      : 0;

    const verdicts = Array.isArray(verifierOutput && verifierOutput.verdicts)
      ? verifierOutput.verdicts
      : [];
    const verifiedFlags = [];
    const downgradedFlags = [];
    const rejectedFlags = [];

    modelFlags.forEach((flag, index) => {
      const id = 'F' + (index + 1);
      const verdict = verdicts.find(
        (entry) => String((entry && entry.id) || '').trim().toUpperCase() === id
      );
      const decision = String((verdict && verdict.decision) || '').trim().toLowerCase();
      const reason = flat(verdict && verdict.reason);
      const evidence = flat(verdict && verdict.evidence);

      if (decision === 'reject' && evidence) {
        rejectedFlags.push({ ...flag, verifierReason: reason, verifierEvidence: evidence });
        return;
      }
      if (decision === 'reject' || decision === 'downgrade') {
        // No quoted evidence, or the verifier is unsure: the flag stays in the report
        // at Minor for the officer to settle.
        const note =
          reason ||
          (decision === 'reject'
            ? 'Rejected without the evidence that would settle it.'
            : 'Lowered to Minor by the verifier.');
        downgradedFlags.push({ ...flag, verifierReason: note });
        verifiedFlags.push({ ...flag, severity: 'Minor' });
        return;
      }
      verifiedFlags.push(flag);
    });

    const baseFlags = mergeDuplicateFlags([...codeFlags, ...verifiedFlags]).flags;

    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

    // Pass 2c: human-review routing, decided in code. Every reason is paired with a
    // flag in the report, so a routed case never shows an empty gap list.
    const modelHumanReview =
      parsed.humanReview && typeof parsed.humanReview === 'object' ? parsed.humanReview : {};

    const routingResult = routingEntries({
      caseRecord,
      sentences,
      flags: baseFlags,
      modelReasons: Array.isArray(modelHumanReview.reasons) ? modelHumanReview.reasons : [],
      citationCheck,
      droppedFlags: confidenceCheck.dropped,
      lowConfidenceCritical: confidenceCheck.lowConfidenceCritical,
      rejectedFlags,
      modelNeeded: Boolean(modelHumanReview.needed)
    });
    const routing = routingResult.entries;

    // The dedupe pass: one flag per issue. Code-check and verified flags come first,
    // so the merged flag keeps the code check's wording on a severity tie.
    const reportFlags = mergeDuplicateFlags([
      ...baseFlags,
      ...routing.flatMap((entry) => entry.flags)
    ]).flags;

    const humanReview = {
      needed: Boolean(modelHumanReview.needed) || routing.length > 0,
      reasons: routing.map((entry) => entry.text)
    };

    const review = await base44.asServiceRole.entities.Review.create({
      caseId,
      createdAt: new Date().toISOString(),
      durationSeconds,
      modelUsed,
      extractedFacts,
      flags: reportFlags,
      citationCheck,
      humanReview,
      rawModelOutput: JSON.stringify(
        {
          reviewerModel: {
            requested: reviewerRequested,
            used: reviewerUsed,
            fallbackReason: reviewerFallback || null
          },
          pass1: parsed,
          verifier: verifierError ? { error: verifierError } : verifierOutput,
          codeChecks: {
            unverified: [...quoteCheck.unverified, ...routingResult.unverified],
            lowConfidence: confidenceCheck.dropped,
            mannerConfusionDropped: mannerCheck.dropped,
            silentFieldClaimsDropped: silentFieldCheck.dropped,
            mergedDuplicates: candidateMerge.mergedCount,
            codeFlagsAdded: codeFlags.length
          },
          verifierDowngraded: downgradedFlags,
          rejectedByVerifier: rejectedFlags,
          routingReasons: routing,
          timings: { pass1Seconds, verifierSeconds, totalSeconds: durationSeconds }
        },
        null,
        2
      )
    });

    const nextStatus = humanReview.needed ? 'Needs Human Review' : 'Reviewed';
    await base44.asServiceRole.entities.Case.update(caseId, { status: nextStatus });

    await base44.asServiceRole.entities.AuditLog.create({
      caseId,
      action: 'Gap check run',
      user: user.email,
      timestamp: new Date().toISOString(),
      details:
        reportFlags.length +
        ' flag(s) and ' +
        extractedFacts.length +
        ' extracted fact(s) from ' +
        sentences.length +
        ' sentence(s) in ' +
        durationSeconds +
        's. Citation check: ' +
        citationCheck.status +
        '. Second reviewer kept ' +
        verifiedFlags.length +
        ' of ' +
        modelFlags.length +
        ' flag(s), lowered ' +
        downgradedFlags.length +
        ' to Minor, rejected ' +
        rejectedFlags.length +
        '. ' +
        codeFlags.length +
        ' code check flag(s) added. Human review ' +
        (humanReview.needed ? 'required' : 'not indicated') +
        '. Reviewer model: ' +
        reviewerUsed +
        (reviewerFallback ? ' (gpt-oss-20b failed: ' + reviewerFallback + ')' : '') +
        '.'
    });

    const droppedFlags = [
      ...quoteCheck.unverified.map((flag) => ({ flag, label: 'unverified' })),
      ...routingResult.unverified.map((flag) => ({ flag, label: 'unverified' })),
      ...silentFieldCheck.dropped.map((flag) => ({
        flag,
        label: 'not an inconsistency (the narrative never mentions it)'
      })),
      ...confidenceCheck.dropped.map((flag) => ({ flag, label: 'low confidence' })),
      ...mannerCheck.dropped.map((flag) => ({ flag, label: 'manner of entry vs manner of encounter' }))
    ];

    if (droppedFlags.length > 0 || candidateMerge.mergedCount > 0) {
      await base44.asServiceRole.entities.AuditLog.create({
        caseId,
        action: 'Flags dropped',
        user: user.email,
        timestamp: new Date().toISOString(),
        details: [
          ...droppedFlags.map(
            (entry) =>
              entry.label +
              ': [' +
              flat(entry.flag && entry.flag.type) +
              '] ' +
              (flat(entry.flag && entry.flag.element) ||
                flat(entry.flag && entry.flag.source) ||
                'unnamed element') +
              ' (source: ' +
              (flat(entry.flag && entry.flag.source) || 'none given') +
              ')' +
              (flat(entry.flag && entry.flag.quote)
                ? ' · quote: "' + flat(entry.flag.quote) + '"'
                : '')
          ),
          candidateMerge.mergedCount > 0
            ? candidateMerge.mergedCount + ' duplicate flag(s) merged'
            : '',
          silentFieldCheck.dropped.length > 0
            ? silentFieldCheck.dropped.length +
              ' flag(s) dropped: the fields state the fact and the narrative never mentions it'
            : ''
        ]
          .filter(Boolean)
          .join('\n')
      });
    }

    return Response.json({ review });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}