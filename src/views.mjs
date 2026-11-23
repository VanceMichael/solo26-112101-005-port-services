import { isCurrentPayable } from './domain.mjs';

function areaReadiness(store) {
  const readiness = {};
  for (const [area, info] of Object.entries(store.state.areas)) {
    const missing = info.pages.some(page => page.status >= 400 || page.missingReason);
    readiness[area] = {
      ready: !missing,
      pages: info.pages.map(page => ({
        url: page.url,
        status: page.status,
        missingReason: page.missingReason ?? null,
      })),
    };
  }
  return readiness;
}

function claimView(claim) {
  return {
    claimId: claim.claimId,
    project: claim.project,
    document: claim.document,
    revision: claim.revision,
    line: claim.line,
    segment: claim.segment,
    amount: claim.amount,
    status: claim.status,
    currentPayable: isCurrentPayable(claim),
    late: claim.late,
    reversed: claim.reversed === true,
    queue: claim.queue,
    blockers: claim.blockers ?? [],
    supersedes: claim.supersedes ?? [],
    receipts: claim.receipts,
    sourceDocumentId: claim.sourceDocumentId,
  };
}

// 管理公司视角：全部港区、原单（含差异与重取入口）、追补、请款与修订记录。
export function managementView(store) {
  return {
    portal: store.state.portal,
    areaReadiness: areaReadiness(store),
    documents: store.state.documents.map(doc => ({
      id: doc.id,
      document: doc.document,
      revision: doc.revision,
      call: doc.call,
      vessel: doc.vessel,
      area: doc.area,
      agent: doc.agent,
      verified: doc.verified,
      filename: doc.filename,
      sha256: doc.sha256,
      savedPath: doc.savedPath,
      differences: doc.differences,
      refetch: doc.refetch,
      fetchedAt: doc.fetchedAt,
      lineCount: doc.lines.length,
    })),
    assignments: store.state.assignments,
    followUps: store.state.followUps,
    corrections: store.state.corrections,
    claims: store.state.claims.map(claimView),
    queues: {
      prepared: store.state.claims.filter(c => c.status === 'prepared').map(c => c.claimId),
      currentPayable: store.state.claims.filter(isCurrentPayable).map(c => ({
        claimId: c.claimId, project: c.project, amount: c.amount,
      })),
      stopped: store.state.claims.filter(c => c.status === 'stopped').map(c => c.claimId),
      waitingReverse: store.state.claims
        .filter(c => c.status === 'reverse-queued' || (c.status === 'accepted' && !c.reversed && c.late))
        .map(c => c.claimId),
    },
  };
}

// 项目视角：只含本项目授权内的明细与请款，来源仅给证明本行的引用，不含整份原单。
export function projectView(store, project) {
  const assignments = store.state.assignments
    .filter(item => item.project === project && !item.superseded)
    .map(item => ({
      assignmentId: item.id,
      document: item.document,
      revision: item.revision,
      call: item.call,
      line: item.line,
      service: item.service,
      segment: item.segment,
      amount: item.amount,
      basis: item.basis,
      authWindow: item.authWindow,
      // 只暴露证明本行的来源引用；含其它项目明细的原件不在项目侧展开。
      source: {
        documentId: item.source.documentId,
        caseUrl: item.source.caseUrl,
        exportUrl: item.source.exportUrl,
        sha256: item.source.sha256,
        filename: item.source.filename,
      },
    }));
  const claims = store.state.claims
    .filter(claim => claim.project === project)
    .map(claimView);
  return {
    project,
    assignments,
    claims,
    currentPayable: claims.filter(claim => claim.currentPayable),
  };
}

// 某份原单/修订影响到哪些明细与请款（修订影响面追溯）。
export function revisionImpact(store, document, revision) {
  return {
    assignments: store.state.assignments
      .filter(item => item.document === document && item.revision === revision)
      .map(item => item.id),
    claims: store.state.claims
      .filter(claim => claim.document === document && claim.revision === revision)
      .map(claimView),
  };
}
