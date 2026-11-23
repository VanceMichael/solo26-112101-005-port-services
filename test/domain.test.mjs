import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import {
  buildClaimId,
  dispatchBlockers,
  isCurrentPayable,
  prepareClaims,
  resolveAuthorization,
  serviceKey,
} from '../src/domain.mjs';
import { assignDocument } from '../src/domain.mjs';
import { applyRevision } from '../src/corrections.mjs';
import { managementView, projectView } from '../src/views.mjs';

const agencies = [
  { project: 'PR-6', agent: 'M-26', area: 'north', call: 'B-08', from: 17, until: 20 },
  { project: 'PR-9', agent: 'M-27', area: 'north', call: 'B-08', from: 20, until: 25 },
  { project: 'PR-3', agent: 'M-61', area: 'south', call: 'B-19', from: 17, until: 26 },
  { project: 'PR-4', agent: 'M-28', area: 'north', call: 'B-09', from: 19, until: 23 },
];

function docFixture(overrides = {}) {
  return {
    id: 'DOC-1',
    document: 'SV-19',
    revision: 1,
    call: 'B-08',
    vessel: 'SEA-201',
    area: 'north',
    agent: 'M-26',
    agents: ['M-26', 'M-27'],
    caseUrl: '/case/19',
    exportUrl: '/exports/V31',
    filename: 'SV-19-r1.csv',
    sha256: 'abc',
    verified: true,
    lines: [
      {
        line: 'L1', service: '拖轮', start: 18, end: 22, amount: 450,
        segments: [
          { start: 18, end: 20, amount: 230 },
          { start: 20, end: 22, amount: 220 },
        ],
      },
      { line: 'L2', service: '供水', start: 21, end: 23, amount: 160, segments: null },
    ],
    ...overrides,
  };
}

test('授权按代理/港区/批次与含起不含止时间窗唯一命中', () => {
  assert.equal(
    resolveAuthorization(agencies, { agents: ['M-26'], area: 'north', call: 'B-08', start: 18, end: 20 })
      .authorization.project,
    'PR-6');
  // 20 点整点属于下一班（含起不含止）。
  assert.equal(
    resolveAuthorization(agencies, { agents: ['M-27'], area: 'north', call: 'B-08', start: 20, end: 22 })
      .authorization.project,
    'PR-9');
  // 批次不同即使时间重叠也不命中。
  assert.equal(
    resolveAuthorization(agencies, { agents: ['M-28'], area: 'north', call: 'B-09', start: 18, end: 20 })
      .status,
    'gap');
});

test('跨班明细仅在原单提供分段依据时拆给各项目', () => {
  const store = new Store('memory');
  const result = assignDocument(store, docFixture(), agencies, 't1');
  assert.equal(result.assigned.length, 3);
  const l1a = store.findAssignment('SV-19', 1, 'L1', '18-20');
  const l1b = store.findAssignment('SV-19', 1, 'L1', '20-22');
  const l2 = store.findAssignment('SV-19', 1, 'L2', '21-23');
  assert.equal(l1a.project, 'PR-6');
  assert.equal(l1a.basis, 'split');
  assert.equal(l1b.project, 'PR-9');
  assert.equal(l2.project, 'PR-9');
  assert.equal(l2.basis, 'whole');
  assert.deepEqual(result.followUps, []);
});

test('无分段依据的跨班整行不拆，转管理公司追补', () => {
  const store = new Store('memory');
  const doc = docFixture({
    agents: ['M-26', 'M-27'],
    lines: [{ line: 'L9', service: '岸电', start: 19, end: 21, amount: 300, segments: null }],
  });
  const result = assignDocument(store, doc, agencies, 't1');
  assert.equal(result.assigned.length, 0);
  assert.equal(result.followUps.length, 1);
  assert.equal(result.followUps[0].reason, 'coarse-line');
});

test('授权间隙的分段单独追补，不阻塞同单其它明细', () => {
  const store = new Store('memory');
  const doc = docFixture({
    call: 'B-09',
    agent: 'M-28',
    agents: ['M-28'],
    revision: 2,
    lines: [{
      line: 'L1', service: '拖轮', start: 18, end: 22, amount: 420,
      segments: [
        { start: 18, end: 20, amount: 220 },
        { start: 20, end: 22, amount: 200 },
      ],
    }],
  });
  const result = assignDocument(store, doc, agencies, 't1');
  assert.equal(result.assigned.length, 1);
  assert.equal(result.assigned[0].project, 'PR-4');
  assert.equal(result.followUps.length, 1);
  assert.equal(result.followUps[0].reason, 'authorization-gap');
  assert.equal(result.followUps[0].segment, '18-20');
});

test('重叠授权无法以正式替代号解除时报冲突追补', () => {
  const store = new Store('memory');
  const conflicted = [
    ...agencies,
    { project: 'PR-X', agent: 'M-26', area: 'north', call: 'B-08', from: 17, until: 22 },
  ];
  const decision = resolveAuthorization(conflicted, {
    agents: ['M-26'], area: 'north', call: 'B-08', start: 18, end: 19,
  });
  assert.equal(decision.status, 'ambiguous');
  const doc = docFixture({
    agents: ['M-26'],
    lines: [{ line: 'L1', service: '拖轮', start: 18, end: 19, amount: 100, segments: null }],
  });
  const result = assignDocument(store, doc, conflicted, 't1');
  assert.equal(result.followUps[0].reason, 'ambiguous-authorization');
});

test('请款准备幂等，且 claimId 与财务定位约定一致', () => {
  const store = new Store('memory');
  assignDocument(store, docFixture(), agencies, 't1');
  const first = prepareClaims(store, 't1');
  const second = prepareClaims(store, 't1');
  assert.equal(store.state.claims.length, 3);
  assert.equal(first.length, second.length);
  const claim = store.findClaim(buildClaimId('SV-19', 1, 'L1', 18, 20), 'PR-6');
  assert.equal(claim.claimId, 'SV-19/1/L1/18-20');
  assert.equal(claim.status, 'prepared');
});

test('同一服务存在已接收未冲回承诺时，新请款被阻断不得双边待付', () => {
  const store = new Store('memory');
  assignDocument(store, docFixture(), agencies, 't1');
  prepareClaims(store, 't1');
  const oldClaim = store.findClaim('SV-19/1/L1/18-20', 'PR-6');
  oldClaim.status = 'accepted';
  oldClaim.receipts.push({ receipt: 'F61', state: 'accepted', amount: 230 });
  const replacement = store.addClaim({
    claimId: 'SV-19/2/L1/18-20',
    project: 'PR-4',
    document: 'SV-19',
    revision: 2,
    line: 'L1',
    segment: '18-20',
    amount: 220,
    status: 'prepared',
    receipts: [],
    serviceKey: serviceKey('SV-19', 'L1', '18-20'),
    blockers: [],
  });
  const blockers = dispatchBlockers(store, replacement);
  assert.match(blockers[0], /F61/);
  assert.ok(!isCurrentPayable(replacement));
  assert.ok(isCurrentPayable(oldClaim));
});

test('错靠泊修订：旧项目停止领用，新项目仅按新批次授权取得明细', () => {
  const store = new Store('memory');
  const first = docFixture();
  assignDocument(store, first, agencies, 't1');
  prepareClaims(store, 't1');
  // 一条旧请款已被财务接收（迟到承诺的前置状态）。
  const accepted = store.findClaim('SV-19/1/L1/18-20', 'PR-6');
  accepted.status = 'accepted';
  accepted.receipts.push({ receipt: 'F61', state: 'accepted', amount: 230 });

  const next = docFixture({
    id: 'DOC-2',
    revision: 2,
    call: 'B-09',
    agent: 'M-28',
    agents: ['M-28'],
    filename: 'SV-19-r2.csv',
    sha256: 'def',
    lines: [
      {
        line: 'L1', service: '拖轮', start: 18, end: 22, amount: 420,
        segments: [
          { start: 18, end: 20, amount: 220 },
          { start: 20, end: 22, amount: 200 },
        ],
      },
      { line: 'L2', service: '供水', start: 21, end: 23, amount: 150, segments: null },
    ],
  });
  const record = applyRevision(store, first, next, agencies, 't2',
    (s, d, a, t) => assignDocument(s, d, a, t));
  assert.equal(record.wrongBerth, true);

  // 旧修订明细全部被取代，旧项目视角不再可见。
  assert.ok(store.state.assignments
    .filter(item => item.revision === 1).every(item => item.superseded));
  // 未发出的旧请款停止发送；已接收的保留原编号等待冲回。
  assert.equal(store.findClaim('SV-19/1/L1/20-22', 'PR-9').status, 'stopped');
  assert.equal(store.findClaim('SV-19/1/L2/21-23', 'PR-9').status, 'stopped');
  assert.equal(store.findClaim('SV-19/1/L1/18-20', 'PR-6').status, 'accepted');

  // 新项目只拿到新批次授权窗内的部分（20-22、21-23），18-20 是授权间隙。
  const pr4 = projectView(store, 'PR-4');
  assert.deepEqual(pr4.assignments.map(a => a.segment).sort(), ['20-22', '21-23']);
  const pr6 = projectView(store, 'PR-6');
  assert.deepEqual(pr6.assignments, []);
  assert.equal(store.state.followUps.filter(f => f.revision === 2 && f.reason === 'authorization-gap').length, 1);

  // 新请款挂取代关系，且因旧承诺未冲回而被阻断。
  const newClaim = store.findClaim('SV-19/2/L1/20-22', 'PR-4');
  assert.deepEqual(newClaim.supersedes, ['SV-19/1/L1/20-22']);
  assert.equal(dispatchBlockers(store, newClaim).length, 0);
});

test('项目侧只见本项目明细与来源引用，管理公司可见差异与追补', () => {
  const store = new Store('memory');
  assignDocument(store, docFixture(), agencies, 't1');
  prepareClaims(store, 't1');
  store.addDocument({
    id: 'DOC-9', verified: false, document: 'SV-19', revision: 2, call: 'B-09',
    vessel: 'SEA-201', area: 'north', agent: 'M-28', filename: 'SV-19-r2.csv',
    sha256: 'zzz', lines: [], differences: ['内容与详情页不一致'],
    refetch: { exportUrl: '/exports/V31', caseUrl: '/case/19' },
  });
  const pr9 = projectView(store, 'PR-9');
  assert.ok(pr9.assignments.every(a => a.project === undefined));
  assert.equal(pr9.assignments.length, 2);
  assert.ok(pr9.assignments[0].source.sha256);
  assert.ok(!('lines' in pr9.assignments[0].source));
  const mgmt = managementView(store);
  assert.equal(mgmt.documents.find(d => d.id === 'DOC-9').verified, false);
  assert.deepEqual(mgmt.documents.find(d => d.id === 'DOC-9').refetch, {
    exportUrl: '/exports/V31', caseUrl: '/case/19',
  });
});
