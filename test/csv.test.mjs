import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, parseSplit } from '../src/csv.mjs';
import { verifyFetchedFile } from '../src/portal.mjs';

const detail = {
  document: 'SV-19',
  revision: 2,
  call: 'B-09',
  vessel: 'SEA-201',
};

test('CSV 解析支持表头、CRLF、引号与空行', () => {
  const { fields, records } = parseCsv('a,b\r\n1,"x,y"\r\n\r\n');
  assert.deepEqual(fields, ['a', 'b']);
  assert.deepEqual(records, [{ a: '1', b: 'x,y' }]);
});

test('split 空值表示整行，竖线分段被完整解析', () => {
  assert.equal(parseSplit(''), null);
  assert.deepEqual(parseSplit('18-20:230|20-22:220'), [
    { start: 18, end: 20, amount: 230 },
    { start: 20, end: 22, amount: 220 },
  ]);
  assert.throws(() => parseSplit('18~20:1'), /无法识别/);
});

test('文件名与内容全部互证时下载通过核验', () => {
  const csv = 'document,revision,call,vessel,line,service,start,end,amount,split\n'
    + 'SV-19,2,B-09,SEA-201,L1,拖轮,18,22,420,18-20:220|20-22:200\n';
  const result = verifyFetchedFile({
    bytes: Buffer.from(csv, 'utf8'),
    filename: 'SV-19-r2.csv',
  }, detail);
  assert.equal(result.verified, true);
  assert.deepEqual(result.differences, []);
  assert.equal(result.lines[0].segments.length, 2);
});

test('文件名对但内容是另一份原单时保留差异并给出重取', () => {
  const csv = 'document,revision,call,vessel,line,service,start,end,amount,split\n'
    + 'SV-63,2,B-19,SEA-402,M1,供水,20,22,250,\n';
  const result = verifyFetchedFile({
    bytes: Buffer.from(csv, 'utf8'),
    filename: 'SV-19-r2.csv',
  }, detail);
  assert.equal(result.verified, false);
  assert.ok(result.differences.some(message => message.includes('SV-63')));
  assert.ok(result.differences.some(message => message.includes('B-19')));
});

test('文件名本身不符也记差异，核验失败不产生明细', () => {
  const csv = 'document,revision,call,vessel,line,service,start,end,amount,split\n'
    + 'SV-19,2,B-09,SEA-201,L1,拖轮,18,22,420,\n';
  const result = verifyFetchedFile({
    bytes: Buffer.from(csv, 'utf8'),
    filename: 'wrong.csv',
  }, detail);
  assert.equal(result.verified, false);
  assert.equal(result.lines.length, 0);
  assert.ok(result.differences[0].includes('文件名'));
});
