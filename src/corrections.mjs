import { buildClaimId, serviceKey } from './domain.mjs';

// 处理同一原单号的新修订（含识别为错靠泊、换代理/换批次的情况）。
// 旧修订明细：
//   - 未派发的请款直接停止发送；
//   - 已在财务队列/已接收的保持原编号，等待回执对账后按原号冲回；
//   - 旧项目因此不能再次领用；
// 新修订的归属仍只按其自身批次的班次授权判定，未授权项目不会得到任何复制件。
export function applyRevision(store, previousDoc, nextDoc, agencies, at, assignDocument) {
  const record = {
    document: nextDoc.document,
    fromRevision: previousDoc.revision,
    toRevision: nextDoc.revision,
    wrongBerth: previousDoc.call !== nextDoc.call,
    previousCall: previousDoc.call,
    nextCall: nextDoc.call,
    previousAgent: previousDoc.agent,
    nextAgent: nextDoc.agent,
    at,
    stoppedClaims: [],
    outstandingClaims: [],
    assignments: { assigned: [], followUps: [] },
  };

  // 1) 旧修订明细全部标记为被取代，旧项目视角随即不可再领用。
  for (const assignment of store.state.assignments) {
    if (assignment.document === previousDoc.document
      && assignment.revision === previousDoc.revision) {
      assignment.superseded = true;
      assignment.supersededBy = nextDoc.revision;
    }
  }

  // 2) 旧修订请款：未发即停；已发留痕，靠回执决定冲回。
  for (const claim of store.state.claims) {
    if (claim.document === previousDoc.document && claim.revision === previousDoc.revision) {
      if (claim.status === 'prepared') {
        claim.status = 'stopped';
        claim.stoppedAt = at;
        record.stoppedClaims.push(claim.claimId);
      } else {
        record.outstandingClaims.push({
          claimId: claim.claimId,
          project: claim.project,
          status: claim.status,
        });
      }
    }
  }

  // 3) 新修订独立走授权判定；授权间隙自然落入追补，不向无权限项目复制原件。
  record.assignments = assignDocument(store, nextDoc, agencies, at);

  // 4) 为新明细准备请款，并挂上对旧请款的取代关系与防双重支付标记。
  for (const assignment of record.assignments.assigned) {
    const claimId = buildClaimId(
      assignment.document, assignment.revision, assignment.line, assignment.start, assignment.end);
    let claim = store.findClaim(claimId, assignment.project);
    if (!claim) {
      claim = store.addClaim({
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
        supersedes: [],
        preparedAt: at,
      });
    }
    for (const old of store.state.claims) {
      if (old.serviceKey === claim.serviceKey
        && old.claimId !== claim.claimId
        && !claim.supersedes.includes(old.claimId)) {
        claim.supersedes.push(old.claimId);
      }
    }
  }

  store.addCorrection(record);
  return record;
}
