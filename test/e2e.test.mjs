import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { IntakeApp, loadAgencies } from '../src/app.mjs';
import { Store } from '../src/store.mjs';
import { startSources } from '../sources/server.mjs';

const source = await startSources();
const agencies = await loadAgencies(new URL('../data/agencies.json', import.meta.url));
let workspace;

async function freshApp() {
  workspace = await mkdtemp(join(tmpdir(), 'port-e2e-'));
  const store = await Store.open(join(workspace, 'state.json'));
  return new IntakeApp({
    store,
    agencies,
    downloadDir: join(workspace, 'downloads'),
    log: () => {},
  });
}

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  await source.close();
});

test('初始阶段：按靠泊批次收件、跨班拆分、未齐港区不阻断、项目视角隔离', async () => {
  const app = await freshApp();
  const summary = await app.collect(source.url, 't-initial');

  // 北区续页 503：登记缺口但不阻断，南区与北区已出部分照常收件。
  const mgmt = app.managementView();
  assert.equal(mgmt.areaReadiness.north.ready, false);
  assert.equal(mgmt.areaReadiness.south.ready, true);
  assert.equal(summary.documents.length, 2);
  assert.deepEqual(summary.discrepancies, []);

  // SV-19 r1/B-08：拖轮按原单分段拆给 PR-6、PR-9；供水整行归 PR-9。
  const pr6 = app.projectView('PR-6');
  assert.deepEqual(pr6.assignments.map(a => `${a.line}@${a.segment}`), ['L1@18-20']);
  const pr9 = app.projectView('PR-9');
  assert.deepEqual(pr9.assignments.map(a => `${a.line}@${a.segment}`).sort(),
    ['L1@20-22', 'L2@21-23']);
  // 项目侧只拿到证明本行的来源引用，不展开含其它项目明细的整份原单。
  assert.ok(pr6.assignments[0].source.sha256);
  assert.equal('lines' in pr6.assignments[0].source, false);

  // 南区 SV-63 归 PR-3；PR-3 无财务请款路由，发送失败被记录但不影响其它项目。
  const pr3 = app.projectView('PR-3');
  assert.equal(pr3.assignments[0].document, 'SV-63');

  const prepared = app.managementView().claims.map(c => c.claimId).sort();
  assert.deepEqual(prepared, [
    'SV-19/1/L1/18-20',
    'SV-19/1/L1/20-22',
    'SV-19/1/L2/21-23',
    'SV-63/2/M1/20-22',
  ]);

  // 只发送北作业区 SV-19 的三条请款（PR-6 一条、PR-9 两条）。
  const sendReport = await app.send(source.url, {
    at: 't-send',
    claims: app.store.state.claims.filter(c => c.document === 'SV-19'),
  });
  assert.equal(sendReport.sent.length, 3);
  assert.deepEqual(sendReport.blocked, []);
  assert.ok(app.store.state.claims
    .filter(c => c.document === 'SV-19')
    .every(c => c.status === 'queued'));

  // PR-3 发送失败（来源没有该项目财务路由），不抛异常、可稍后重试。
  const pr3Report = await app.send(source.url, {
    at: 't-send-pr3',
    claims: app.store.state.claims.filter(c => c.project === 'PR-3'),
  });
  assert.equal(pr3Report.failed[0].status, 404);
});

test('更正阶段：差异留痕与重取、错靠泊交接、迟到回执与冲回、双边待付护栏', async () => {
  // 沿用上一阶段状态，模拟门户重登后接着收。
  const app = new IntakeApp({
    store: await Store.open(join(workspace, 'state.json')),
    agencies,
    downloadDir: join(workspace, 'downloads'),
    log: () => {},
  });

  const switchStage = await fetch(source.url + '/scenario/corrected', { method: 'POST' });
  assert.equal(switchStage.status, 204);

  const summary = await app.collect(source.url, 't-corrected-1');
  // 第一次下载文件名对但内容是 SV-63：差异保留，重取入口登记。
  assert.equal(summary.discrepancies.length, 1);
  const bad = app.store.state.documents.find(d => d.verified === false);
  assert.ok(bad.differences.some(message => message.includes('SV-63')));
  assert.equal(bad.refetch.exportUrl, '/exports/V31');

  // 再次收件触发来源第二次应答，拿到真正属于 B-09 的 r2 文件。
  const second = await app.collect(source.url, 't-corrected-2');
  assert.deepEqual(second.discrepancies, []);
  const good = app.store.state.documents.find(d => d.verified && d.revision === 2
    && d.document === 'SV-19' && d.call === 'B-09');
  assert.ok(good);
  // 续页此时已发布，北区齐备。
  assert.equal(app.managementView().areaReadiness.north.ready, true);

  // 错靠泊：旧修订明细全部被取代，PR-6/PR-9 项目侧不再可见旧明细。
  assert.equal(app.projectView('PR-6').assignments.length, 0);
  assert.equal(app.projectView('PR-9').assignments.length, 0);
  // 已进入财务队列的旧请款不能撤回，保留原编号等待回执；未接收前不进入当前待付。
  const oldClaims = app.store.state.claims
    .filter(c => c.document === 'SV-19' && c.revision === 1);
  assert.ok(oldClaims.every(c => ['queued', 'accepted', 'reverse-queued'].includes(c.status)
    || c.status === 'stopped'));
  assert.ok(oldClaims.every(c => c.status !== 'prepared'));

  // 新项目 PR-4 只取得 B-09 授权窗（19-23）内的明细；18-20 段是授权间隙，转追补。
  const pr4 = app.projectView('PR-4');
  assert.deepEqual(pr4.assignments.map(a => a.segment).sort(), ['20-22', '21-23']);
  const gap = app.store.state.followUps
    .find(f => f.document === 'SV-19' && f.revision === 2 && f.reason === 'authorization-gap');
  assert.equal(gap.segment, '18-20');

  // 第一次对账：PR-6 已有接收回执 F61（原单已更正，因此同时带迟到标记）；PR-9 回执尚未到。
  const reconcile1 = await app.reconcile(source.url, { at: 't-rec-1' });
  assert.deepEqual(reconcile1.accepted.map(r => r.receipt), ['F61']);
  assert.equal(reconcile1.accepted[0].late, true);
  const pr6Claim = app.store.findClaim('SV-19/1/L1/18-20', 'PR-6');
  assert.equal(pr6Claim.status, 'accepted');

  // 第二次对账：PR-9 的迟到接收 F95 到达；晚于更正的接收仍算真实接收并标记 late。
  const reconcile2 = await app.reconcile(source.url, { at: 't-rec-2' });
  assert.deepEqual(reconcile2.late.map(r => r.receipt).sort(), ['F61', 'F95']);
  const pr9Claim = app.store.findClaim('SV-19/1/L1/20-22', 'PR-9');
  assert.equal(pr9Claim.late, true);
  assert.equal(pr9Claim.receipts[0].receipt, 'F95');

  // 按原编号请 PR-9 冲回，第三次对账确认 F96 reversed，金额离开当前账。
  const reverseReport = await app.reverse(source.url, 'SV-19/1/L1/20-22', { at: 't-rev' });
  assert.equal(reverseReport.queued, true);
  await app.reconcile(source.url, { at: 't-rec-3' });
  assert.equal(pr9Claim.reversed, true);

  // PR-6 没有冲回路由：记录失败，旧承诺仍挂账，更正后的同服务请款被阻断、不得双边待付。
  const pr6Reverse = await app.reverse(source.url, 'SV-19/1/L1/18-20', { at: 't-rev-6' });
  assert.equal(pr6Reverse.ok, false);
  assert.equal(pr6Reverse.status, 404);

  // 新修订请款处于准备态；派发时旧承诺未解除的会被拦截并指明回执。
  const sendCorrected = await app.send(source.url, { at: 't-send-r2' });
  const blockedClaim = sendCorrected.blocked.find(b => b.claimId === 'SV-19/2/L1/20-22');
  // PR-9 已冲回，20-22 段不应再被阻断；PR-4 的 21-23 也可发送。
  assert.equal(blockedClaim, undefined);
  assert.ok(sendCorrected.sent.some(s => s.claimId === 'SV-19/2/L1/20-22'));
  assert.ok(sendCorrected.sent.some(s => s.claimId === 'SV-19/2/L2/21-23'));

  // 同服务任何时刻最多只有一条当前待付。
  const payable = app.managementView().queues.currentPayable;
  const serviceKeys = payable.map(c => {
    const claim = app.store.state.claims.find(item => item.claimId === c.claimId);
    return claim.serviceKey;
  });
  assert.equal(new Set(serviceKeys).size, serviceKeys.length);
  // PR-6 的旧承诺仍是当前待付，且更正流水里能查到是哪份迟回执/承诺使更正受阻。
  assert.ok(payable.some(c => c.claimId === 'SV-19/1/L1/18-20'));
  const correction = app.store.state.corrections[0];
  assert.equal(correction.wrongBerth, true);
  assert.deepEqual(correction.outstandingClaims.map(c => c.claimId).sort(),
    ['SV-19/1/L1/18-20', 'SV-19/1/L1/20-22', 'SV-19/1/L2/21-23']);

  // 修订影响面可追溯：r1 影响哪些请款一目了然。
  const impact = app.impact('SV-19', 1);
  assert.ok(impact.claims.some(c => c.claimId === 'SV-19/1/L1/18-20'));

  // 状态已持久化：重新打开应用后数据仍在，可继续接着收。
  const reopened = new IntakeApp({
    store: await Store.open(join(workspace, 'state.json')),
    agencies,
    downloadDir: join(workspace, 'downloads'),
    log: () => {},
  });
  assert.equal(reopened.managementView().claims.length, app.store.state.claims.length);
  assert.ok((await readFile(join(workspace, 'state.json'), 'utf8')).includes('SV-19'));
});
