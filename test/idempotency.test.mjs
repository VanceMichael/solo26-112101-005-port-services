import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { IntakeApp, loadAgencies } from '../src/app.mjs';
import { Store } from '../src/store.mjs';
import { startSources } from '../sources/server.mjs';

const source = await startSources();
const agencies = await loadAgencies(new URL('../data/agencies.json', import.meta.url));
const dirs = [];

after(async () => {
  await fetch(source.url + '/scenario/initial', { method: 'POST' });
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  await source.close();
});

async function makeApp(dir) {
  const store = await Store.open(join(dir, 'state.json'));
  return new IntakeApp({
    store,
    agencies,
    downloadDir: join(dir, 'downloads'),
    log: () => {},
  });
}

test('重复收件幂等：已核验原单不重复判定，状态文件重开后续跑', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'port-idem-'));
  dirs.push(dir);
  const app = await makeApp(dir);

  await app.collect(source.url, 't1');
  const claimsAfterFirst = app.store.state.claims.length;
  const docsAfterFirst = app.store.state.documents.length;
  assert.ok(claimsAfterFirst > 0);

  // 初始阶段重复收件：同样的字节被哈希去重，明细与请款不重复。
  await app.collect(source.url, 't2');
  assert.equal(app.store.state.documents.length, docsAfterFirst);
  assert.equal(app.store.state.claims.length, claimsAfterFirst);
  assert.ok(app.store.state.documents.every(doc => doc.absorbed === true));

  // 重开应用（模拟进程重启），数据完整且可继续操作。
  const reopened = await makeApp(dir);
  assert.equal(reopened.store.state.claims.length, claimsAfterFirst);
  const report = await reopened.send(source.url, {
    at: 't3',
    claims: reopened.store.state.claims.filter(c => c.document === 'SV-19'),
  });
  assert.equal(report.sent.length, 3);
  // 再发一次时已入队的请款不再是 prepared，不会被重复发送。
  const second = await reopened.send(source.url, { at: 't4' });
  assert.equal(second.sent.length, 0);
});

test('未通过核验的差异件永远不进入授权判定与请款', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'port-bad-'));
  dirs.push(dir);
  await fetch(source.url + '/scenario/corrected', { method: 'POST' });
  const app = await makeApp(dir);

  // 第一次更正收件拿到的是 SV-63 内容冒充 SV-19 r2。
  const summary = await app.collect(source.url, 't1');
  assert.equal(summary.discrepancies.length, 1);
  const bad = app.store.state.documents.find(doc => doc.verified === false);
  assert.equal(bad.absorbed, undefined);
  // 差异件不产生任何明细或请款，且保留重取入口。
  assert.deepEqual(app.store.state.assignments
    .filter(item => item.document === 'SV-19' && item.revision === 2), []);
  assert.equal(bad.refetch.exportUrl, '/exports/V31');

  // 即使再次运行吸收流程，差异件依旧被跳过。
  await app.collect(source.url, 't2');
  const good = app.store.state.documents
    .find(doc => doc.verified && doc.document === 'SV-19' && doc.revision === 2);
  assert.ok(good);
  assert.ok(app.store.state.assignments
    .some(item => item.document === 'SV-19' && item.revision === 2));
  assert.equal(bad.absorbed, undefined);
});
