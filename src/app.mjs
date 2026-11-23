import { readFile } from 'node:fs/promises';
import { applyRevision } from './corrections.mjs';
import { assignDocument, prepareClaims } from './domain.mjs';
import { FinanceClient, reconcileReceipts, reverseClaim, dispatchClaims } from './finance.mjs';
import { PortalClient, collectFromPortal } from './portal.mjs';
import { managementView, projectView, revisionImpact } from './views.mjs';

export async function loadAgencies(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// 收件与交接应用：所有跨步骤状态落在 Store，重启后接着跑。
export class IntakeApp {
  constructor({ store, agencies, downloadDir, log = () => {} }) {
    this.store = store;
    this.agencies = agencies;
    this.downloadDir = downloadDir;
    this.log = log;
  }

  // 浏览器收件：门户换页/重登后重复执行即可续上，已核验的原单不会重复处理。
  async collect(portalUrl, at) {
    const client = new PortalClient(portalUrl, this.downloadDir);
    await client.start();
    try {
      const summary = await collectFromPortal(client, this.store, { at }, { log: this.log });
      this.#absorbDocuments(at);
      await this.store.save();
      return summary;
    } finally {
      await client.close();
    }
  }

  // 把本次（及历史上未吸收的）已核验下载纳入授权判定；差异件只留痕不判定。
  #absorbDocuments(at) {
    for (const doc of this.store.state.documents) {
      if (!doc.verified || doc.absorbed) continue;
      const previous = this.store.state.documents
        .filter(other => other.verified && other.document === doc.document
          && other.revision < doc.revision)
        .sort((a, b) => b.revision - a.revision)[0];
      if (previous && !previous.supersededByNext) {
        // 同原单号出现更新修订：错靠泊/换代理在这里交接。
        const record = applyRevision(
          this.store, previous, doc, this.agencies, at,
          (storeArg, nextDoc, auths, time) => assignDocument(storeArg, nextDoc, auths, time));
        previous.supersededByNext = doc.revision;
        doc.absorbed = true;
        prepareClaims(this.store, at);
        this.log(`原单 ${doc.document} 修订 r${previous.revision}→r${doc.revision} 已处理（错靠泊：${
          record.wrongBerth ? '是' : '否'}）`);
        continue;
      }
      const result = assignDocument(this.store, doc, this.agencies, at);
      prepareClaims(this.store, at);
      doc.absorbed = true;
      if (result.followUps.length > 0) {
        this.log(`原单 ${doc.document} r${doc.revision} 有 ${result.followUps.length} 条明细需管理公司追补`);
      }
    }
  }

  async send(portalUrl, options = {}) {
    const client = new FinanceClient(portalUrl);
    const report = await dispatchClaims(this.store, client, options);
    await this.store.save();
    return report;
  }

  async reconcile(portalUrl, options = {}) {
    const client = new FinanceClient(portalUrl);
    const report = await reconcileReceipts(this.store, client, options);
    await this.store.save();
    return report;
  }

  async reverse(portalUrl, claimId, options = {}) {
    const client = new FinanceClient(portalUrl);
    const report = await reverseClaim(this.store, client, claimId, options);
    await this.store.save();
    return report;
  }

  managementView() {
    return managementView(this.store);
  }

  projectView(project) {
    return projectView(this.store, project);
  }

  impact(document, revision) {
    return revisionImpact(this.store, document, revision);
  }
}
