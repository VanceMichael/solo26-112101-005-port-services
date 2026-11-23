import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 收件与交接的全部状态集中在一个 JSON 文件，采用临时文件+改名的原子写。
// 门户换页、重登或进程重启后，凭该文件接着收、接着发。
export function createInitialState() {
  return {
    portal: { url: null, fetchedAt: null },
    areas: {}, // area -> { entryUrl, discoveredAt, pages: [{url, seenAt, status, missingReason}] }
    cases: {}, // caseUrl -> 最近一次详情元数据（同简称重用时以 URL 为准）
    documents: [], // 每次确认为某原单的下载（含差异记录）
    assignments: [], // 可归属到项目授权的明细（含准备/待发/已发等状态）
    followUps: [], // 授权间隙、原单过粗、冲突等待管理公司追补的事项
    claims: [], // 请款行（面向各项目财务）
    corrections: [], // 修订/错靠泊处理记录
  };
}

export class Store {
  constructor(file, state = createInitialState()) {
    this.file = file;
    this.state = state;
  }

  static async open(file) {
    let state;
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = createInitialState();
    }
    return new Store(file, state);
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  // ---- 港区与页面 ----
  noteArea(area, entryUrl, at) {
    this.state.areas[area] ??= { entryUrl, discoveredAt: at, pages: [] };
  }

  notePage(area, url, at, status, missingReason = null) {
    this.noteArea(area, url, at);
    const pages = this.state.areas[area].pages;
    const known = pages.find(page => page.url === url);
    if (known) Object.assign(known, { seenAt: at, status, missingReason });
    else pages.push({ url, seenAt: at, status, missingReason });
  }

  // ---- 详情页 ----
  noteCase(caseUrl, meta) {
    this.state.cases[caseUrl] = { ...this.state.cases[caseUrl], ...meta };
  }

  // ---- 下载原单 ----
  addDocument(record) {
    const id = `DOC-${this.state.documents.length + 1}`;
    this.state.documents.push({ id, ...record });
    return id;
  }

  findAcceptedDocument(document, revision, call, vessel) {
    return this.state.documents.find(
      doc => doc.verified && doc.document === document && doc.revision === revision
        && doc.call === call && doc.vessel === vessel,
    );
  }

  // ---- 授权判定后的明细 ----
  findAssignment(document, revision, line, segment) {
    return this.state.assignments.find(
      item => item.document === document && item.revision === revision
        && item.line === line && item.segment === segment,
    );
  }

  addAssignment(record) {
    this.state.assignments.push(record);
    return record;
  }

  addFollowUp(record) {
    const id = `FU-${this.state.followUps.length + 1}`;
    this.state.followUps.push({ id, ...record });
    return id;
  }

  findFollowUp(document, revision, line, segment, reason) {
    return this.state.followUps.find(
      item => item.document === document && item.revision === revision
        && item.line === line && item.segment === segment && item.reason === reason,
    );
  }

  // ---- 请款 ----
  findClaim(claimId, project) {
    return this.state.claims.find(
      claim => claim.claimId === claimId && claim.project === project,
    );
  }

  addClaim(record) {
    this.state.claims.push(record);
    return record;
  }

  addCorrection(record) {
    const id = `CR-${this.state.corrections.length + 1}`;
    this.state.corrections.push({ id, ...record });
    return id;
  }
}
