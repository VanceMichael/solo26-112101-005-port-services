import { contained, segmentLabel } from './time.mjs';

// 请款行定位：原单/修订/行号/半开时间段（整行用整行区间标注）。
// 与财务侧约定及演练回执中的 claimId 保持一致。
export function buildClaimId(document, revision, line, start, end) {
  return `${document}/${revision}/${line}/${segmentLabel(start, end)}`;
}

// 同一服务跨修订的身份键：换修订不改服务本身，用于防止两边同时挂当前待付。
export function serviceKey(document, line, segment) {
  return `${document}:${line}:${segment}`;
}

function candidateAuthorizations(agencies, target) {
  // 详情页可能同时列出交班前后的多个班次代理（如 M-26/M-27），
  // 因此候选授权只按港区、批次与时间窗过滤，再要求班次代理在原单代理名单内。
  return agencies.filter(auth =>
    target.agents.includes(auth.agent)
    && auth.area === target.area
    && auth.call === target.call
    && overlapsWindow(auth, target.start, target.end));
}

function overlapsWindow(auth, start, end) {
  return auth.from < end && start < auth.until;
}

// 在候选授权中找能完整容纳该半开时间段的唯一正式授权。
// 返回 { status: 'unique'|'ambiguous'|'gap', authorization? }
export function resolveAuthorization(agencies, target) {
  const candidates = candidateAuthorizations(agencies, target);
  const covering = candidates.filter(auth => contained(target.start, target.end, auth));
  if (covering.length === 1) return { status: 'unique', authorization: covering[0] };
  if (covering.length > 1) return { status: 'ambiguous', authorizations: covering };
  return { status: 'gap', candidates };
}

// 把一份已核验原单的全部行，按班次授权判定去向。
// 已生成过的明细幂等跳过；无法判定的进追补清单，不阻塞同行其它判定。
export function assignDocument(store, doc, agencies, at) {
  const results = { assigned: [], followUps: [] };
  for (const line of doc.lines) {
    const start = Number(line.start);
    const end = Number(line.end);
    const fullLabel = segmentLabel(start, end);
    const segments = line.segments ?? [{ start, end, amount: Number(line.amount) }];
    const sourceRef = {
      caseUrl: doc.caseUrl,
      exportUrl: doc.exportUrl,
      documentId: doc.id,
      filename: doc.filename,
      sha256: doc.sha256,
    };

    if (!line.segments && segments.length === 1) {
      // 整行无分段依据：仅当整行完整落在一个授权窗内才能归属。
      const decision = resolveAuthorization(agencies, {
        agents: doc.agents, area: doc.area, call: doc.call, start, end,
      });
      if (decision.status === 'unique') {
        results.assigned.push(registerAssignment(store, {
          doc, line, start, end, amount: Number(line.amount),
          segment: fullLabel, basis: 'whole',
          authorization: decision.authorization, sourceRef, at,
        }));
      } else {
        results.followUps.push(registerFollowUp(store, {
          doc, line, segment: fullLabel, start, end, amount: Number(line.amount),
          reason: decision.status === 'ambiguous' ? 'ambiguous-authorization' : 'coarse-line',
          detail: describeGap(decision), sourceRef, at,
        }));
      }
      continue;
    }

    // 原单提供了分段依据，逐段判定；任何一段缺授权只追补该段。
    for (const segment of segments) {
      const label = segmentLabel(segment.start, segment.end);
      const decision = resolveAuthorization(agencies, {
        agents: doc.agents, area: doc.area, call: doc.call,
        start: segment.start, end: segment.end,
      });
      if (decision.status === 'unique') {
        results.assigned.push(registerAssignment(store, {
          doc, line, start: segment.start, end: segment.end, amount: segment.amount,
          segment: label, basis: 'split',
          authorization: decision.authorization, sourceRef, at,
        }));
      } else {
        results.followUps.push(registerFollowUp(store, {
          doc, line, segment: label, start: segment.start, end: segment.end,
          amount: segment.amount,
          reason: decision.status === 'ambiguous' ? 'ambiguous-authorization' : 'authorization-gap',
          detail: describeGap(decision), sourceRef, at,
        }));
      }
    }
  }
  return results;
}

function registerAssignment(store, spec) {
  const { doc, line, authorization, sourceRef, at } = spec;
  const known = store.findAssignment(doc.document, doc.revision, line.line, spec.segment);
  if (known) return known;
  const assignment = {
    id: `AS-${store.state.assignments.length + 1}`,
    document: doc.document,
    revision: doc.revision,
    call: doc.call,
    vessel: doc.vessel,
    area: doc.area,
    line: line.line,
    service: line.service,
    start: spec.start,
    end: spec.end,
    segment: spec.segment,
    amount: spec.amount,
    basis: spec.basis,
    project: authorization.project,
    agent: authorization.agent,
    authWindow: { from: authorization.from, until: authorization.until },
    source: sourceRef,
    superseded: false,
    preparedAt: at,
  };
  return store.addAssignment(assignment);
}

function registerFollowUp(store, spec) {
  const { doc, line, sourceRef, at } = spec;
  const known = store.findFollowUp(doc.document, doc.revision, line.line, spec.segment, spec.reason);
  if (known) return known;
  const id = store.addFollowUp({
    document: doc.document,
    revision: doc.revision,
    call: doc.call,
    vessel: doc.vessel,
    area: doc.area,
    line: line.line,
    segment: spec.segment,
    start: spec.start,
    end: spec.end,
    amount: spec.amount,
    reason: spec.reason,
    detail: spec.detail,
    source: sourceRef,
    raisedAt: at,
    resolved: false,
  });
  return store.state.followUps.find(item => item.id === id);
}

function describeGap(decision) {
  if (decision.status === 'ambiguous') {
    return `多个授权同时覆盖：${decision.authorizations.map(a => `${a.project}/${a.agent}`).join('、')}`;
  }
  if (decision.candidates.length === 0) return '时间段内没有任何班次授权';
  return `授权只覆盖时间段的一部分：${decision.candidates
    .map(a => `${a.project}/${a.agent} ${a.from}-${a.until}`).join('、')}`;
}

// 为已归属明细准备请款行（幂等）。
export function prepareClaims(store, at) {
  const prepared = [];
  for (const assignment of store.state.assignments) {
    if (assignment.superseded) continue;
    const claimId = buildClaimId(
      assignment.document, assignment.revision, assignment.line, assignment.start, assignment.end);
    const known = store.findClaim(claimId, assignment.project);
    if (known) {
      prepared.push(known);
      continue;
    }
    prepared.push(store.addClaim({
      claimId,
      project: assignment.project,
      document: assignment.document,
      revision: assignment.revision,
      line: assignment.line,
      segment: assignment.segment,
      amount: assignment.amount,
      status: 'prepared',
      assignmentId: assignment.id,
      serviceKey: serviceKey(assignment.document, assignment.line, assignment.segment),
      sourceDocumentId: assignment.source.documentId,
      queue: null,
      dispatchedAt: null,
      receipts: [],
      late: false,
      blockers: [],
      supersedes: null,
      preparedAt: at,
    }));
  }
  return prepared;
}

// 派发前计算阻断原因：被修订取代、同一服务已有未冲回的接收承诺。
export function dispatchBlockers(store, claim) {
  const blockers = [];
  if (claim.status === 'stopped' || claim.status === 'superseded') {
    blockers.push('该请款已随原单修订停止/作废');
  }
  const outstanding = store.state.claims.find(other =>
    other.serviceKey === claim.serviceKey
    && other.claimId !== claim.claimId
    && other.status === 'accepted'
    && !other.reversed);
  if (outstanding) {
    blockers.push(`同一服务在 ${outstanding.project} 仍有已接收未冲回承诺（回执 ${
      outstanding.receipts.map(r => r.receipt).join('、') || '未知'}）`);
  }
  return blockers;
}

export function isCurrentPayable(claim) {
  return claim.status === 'accepted' && !claim.reversed;
}
