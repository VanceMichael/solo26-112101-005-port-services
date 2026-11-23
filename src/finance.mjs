import { dispatchBlockers } from './domain.mjs';

async function postJson(baseUrl, path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: response.status, data };
}

// 财务收件台是独立来源：提交响应仅表示队列收到，真实接收以回执为准。
export class FinanceClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  async dispatchClaim(claim) {
    return postJson(this.baseUrl, `/finance/${claim.project}/claims`, {
      claimId: claim.claimId,
      document: claim.document,
      revision: claim.revision,
      line: claim.line,
      segment: claim.segment,
      amount: claim.amount,
    });
  }

  async fetchReceipts(project) {
    const response = await fetch(this.baseUrl + `/finance/${project}/receipts`);
    if (!response.ok) return { status: response.status, receipts: [] };
    return { status: response.status, receipts: await response.json() };
  }

  async requestReverse(project, claimId) {
    return postJson(this.baseUrl, `/finance/${project}/reverse`, { claimId });
  }
}

// 派发明细请款：被阻断的保持准备态并写明原因，不做发送。
export async function dispatchClaims(store, client, options = {}) {
  const targets = options.claims
    ?? store.state.claims.filter(claim => claim.status === 'prepared');
  const report = { sent: [], blocked: [], failed: [] };
  for (const claim of targets) {
    const blockers = dispatchBlockers(store, claim);
    if (blockers.length > 0) {
      claim.blockers = blockers;
      report.blocked.push({ claimId: claim.claimId, project: claim.project, blockers });
      continue;
    }
    try {
      const result = await client.dispatchClaim(claim);
      if (result.status === 202) {
        claim.status = 'queued';
        claim.queue = result.data?.queue ?? null;
        claim.dispatchedAt = options.at ?? new Date().toISOString();
        claim.blockers = [];
        report.sent.push({ claimId: claim.claimId, project: claim.project, queue: claim.queue });
      } else {
        report.failed.push({ claimId: claim.claimId, project: claim.project, status: result.status });
      }
    } catch (error) {
      report.failed.push({ claimId: claim.claimId, project: claim.project, error: error.message });
    }
  }
  return report;
}

// 拉取各项目回执并对账。回执可能比下一次门户更正晚到：
// 已被停止/取代的请款若出现 accepted 回执，仍计为真实接收（late=true），须再走冲回。
export async function reconcileReceipts(store, client, options = {}) {
  const at = options.at ?? new Date().toISOString();
  const projects = [...new Set(store.state.claims.map(claim => claim.project))];
  const report = { accepted: [], late: [], reversed: [], observed: [] };
  for (const project of projects) {
    const { status, receipts } = await client.fetchReceipts(project);
    if (status !== 200) {
      report.observed.push({ project, status, receipts: [] });
      continue;
    }
    report.observed.push({ project, status, receipts });
    for (const receipt of receipts) {
      const claim = store.state.claims.find(
        item => item.project === project && item.claimId === receipt.claimId);
      if (!claim) continue;
      const known = claim.receipts.some(item => item.receipt === receipt.receipt);
      if (!known) {
        claim.receipts.push({
          receipt: receipt.receipt,
          state: receipt.state,
          amount: receipt.amount,
          observedAt: at,
        });
      }
      if (receipt.state === 'accepted') {
        // 请款对应明细已被修订取代（或请款本身已停止）时到达的接收，仍是真实接收，
        // 只是晚于更正：计入 accepted 并同时打 late 标记，后续必须按原号冲回。
        const assignment = store.state.assignments.find(item => item.id === claim.assignmentId);
        const late = claim.status === 'stopped' || claim.status === 'superseded'
          || assignment?.superseded === true;
        claim.status = 'accepted';
        claim.late = claim.late || late;
        claim.reversed = false;
        report.accepted.push({
          claimId: claim.claimId, project, receipt: receipt.receipt,
          amount: receipt.amount, late,
        });
        if (late) report.late.push({
          claimId: claim.claimId, project, receipt: receipt.receipt, amount: receipt.amount,
        });
      } else if (receipt.state === 'reversed') {
        claim.reversed = true;
        if (claim.status === 'reverse-queued' || claim.status === 'accepted') {
          claim.status = 'accepted'; // 保留原接收事实，用 reversed 表达已冲回
        }
        report.reversed.push({
          claimId: claim.claimId, project, receipt: receipt.receipt, amount: receipt.amount,
        });
      }
    }
  }
  return report;
}

// 按原编号请财务确认冲回。只有回执变 reversed 才算金额真正离开项目当前账。
export async function reverseClaim(store, client, claimId, options = {}) {
  const claim = store.state.claims.find(item => item.claimId === claimId);
  if (!claim) return { ok: false, reason: 'unknown-claim' };
  if (claim.status !== 'accepted') {
    return { ok: false, reason: 'not-accepted', status: claim.status };
  }
  if (claim.reversed) return { ok: true, alreadyReversed: true, claimId };
  const result = await client.requestReverse(claim.project, claim.claimId);
  if (result.status === 202) {
    claim.status = 'reverse-queued';
    claim.reverseQueue = result.data?.queue ?? null;
    claim.reverseRequestedAt = options.at ?? new Date().toISOString();
    return { ok: true, queued: true, claimId, project: claim.project, queue: claim.reverseQueue };
  }
  claim.reverseFailure = { status: result.status, at: options.at ?? new Date().toISOString() };
  return { ok: false, status: result.status, claimId, project: claim.project };
}
