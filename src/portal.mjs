import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { parseCsv, parseSplit } from './csv.mjs';

const DETAIL_FIELDS = {
  船舶识别号: 'vessel',
  靠泊批次: 'call',
  内容修订: 'revision',
  停靠时间: 'berthWindow',
  代理: 'agentsText',
};

// 在页面上下文内抽取标题、定义列表与全部链接。
function readPage(tab) {
  return tab.evaluate(() => {
    const dl = {};
    document.querySelectorAll('dl').forEach(list => {
      const children = [...list.children];
      for (let i = 0; i < children.length; i += 1) {
        if (children[i].tagName === 'DT') {
          const dd = children[i + 1];
          dl[children[i].textContent.trim()] = dd ? dd.textContent.trim() : '';
        }
      }
    });
    return {
      title: document.querySelector('h1')?.textContent.trim() ?? '',
      dl,
      links: [...document.querySelectorAll('a[href]')].map(a => ({
        text: a.textContent.trim(),
        href: new URL(a.getAttribute('href'), location.href).pathname,
        download: a.hasAttribute('download'),
      })),
      bodyText: document.body.innerText,
    };
  });
}

function parseCaseDetail(raw) {
  const meta = { title: raw.title, agents: [] };
  for (const [cn, key] of Object.entries(DETAIL_FIELDS)) {
    if (raw.dl[cn] !== undefined) meta[key] = raw.dl[cn];
  }
  const titleMatch = /服务原单\s+(\S+)/.exec(raw.title);
  if (titleMatch) meta.document = titleMatch[1];
  meta.revision = Number(meta.revision);
  if (meta.berthWindow) {
    const windowMatch = /(\d+)\s*至\s*(\d+)/.exec(meta.berthWindow);
    if (windowMatch) meta.berth = { from: Number(windowMatch[1]), until: Number(windowMatch[2]) };
  }
  if (meta.agentsText) meta.agents = meta.agentsText.split('/').map(s => s.trim());
  return meta;
}

function areaFromPath(path) {
  const match = /^\/west\/([^/]+)/.exec(path);
  return match ? match[1] : null;
}

// 门户浏览器：负责按港区进入详情、触发下载并核验文件确实属于本次搜索与具体靠泊。
export class PortalClient {
  constructor(baseUrl, downloadDir) {
    this.baseUrl = baseUrl;
    this.downloadDir = downloadDir;
  }

  async start() {
    this.browser = await chromium.launch();
    this.context = await this.browser.newContext({ acceptDownloads: true });
    this.tab = await this.context.newPage();
  }

  async close() {
    await this.browser?.close();
  }

  // 打开一个可能返回 503 的门户页：HTTP 状态与正文一起带回。
  async open(path) {
    const response = await this.tab.goto(this.baseUrl + path, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    let page = null;
    if (status >= 200 && status < 300) page = await readPage(this.tab);
    return { status, page, body: status >= 400 ? await this.tab.content() : '' };
  }

  // 从当前已打开的详情页触发浏览器下载，返回字节、文件名与响应状态。
  async triggerDownload(exportPath) {
    const downloadPromise = this.tab.waitForEvent('download');
    await this.tab.getByRole('link', { name: '领取原单' }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return {
      bytes: Buffer.concat(chunks),
      filename: download.suggestedFilename(),
      status: 200,
      exportPath,
    };
  }
}

// 把下载字节解析成原单结构，并与详情页元数据互证。
// 文件名或内容对不上时不丢弃：保留差异并给出重取入口。
export function verifyFetchedFile(fetchRecord, detail) {
  const sha256 = createHash('sha256').update(fetchRecord.bytes).digest('hex');
  const text = fetchRecord.bytes.toString('utf8');
  const nameMatch = /^(.+)-r(\d+)\.csv$/i.exec(fetchRecord.filename);
  const differences = [];
  if (!nameMatch) differences.push(`文件名不符合 原单号-r修订.csv：${fetchRecord.filename}`);
  else if (nameMatch[1] !== detail.document) {
    differences.push(`文件名原单号 ${nameMatch[1]} 与详情页 ${detail.document} 不一致`);
  }

  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    return {
      verified: false,
      sha256,
      differences: [...differences, `CSV 无法解析：${error.message}`],
      lines: [],
    };
  }

  const lines = [];
  for (const record of parsed.records) {
    lines.push({
      line: record.line,
      service: record.service,
      start: Number(record.start),
      end: Number(record.end),
      amount: Number(record.amount),
      segments: parseSplit(record.split),
      rawDocument: record.document,
      rawRevision: Number(record.revision),
      rawCall: record.call,
      rawVessel: record.vessel,
    });
  }

  if (lines.length === 0) differences.push('文件没有任何服务明细行');
  for (const line of lines) {
    if (line.rawDocument !== detail.document) {
      differences.push(`行 ${line.line} 原单号 ${line.rawDocument} 与详情页 ${detail.document} 不一致`);
    }
    if (line.rawRevision !== detail.revision) {
      differences.push(`行 ${line.line} 修订 r${line.rawRevision} 与详情页 r${detail.revision} 不一致`);
    }
    if (line.rawVessel !== detail.vessel) {
      differences.push(`行 ${line.line} 船舶识别号 ${line.rawVessel} 与详情页 ${detail.vessel} 不一致`);
    }
    if (line.rawCall !== detail.call) {
      differences.push(`行 ${line.line} 靠泊批次 ${line.rawCall} 与详情页 ${detail.call} 不一致`);
    }
  }

  return {
    verified: differences.length === 0,
    sha256,
    differences,
    csvDocument: lines[0]?.rawDocument ?? null,
    csvRevision: lines[0]?.rawRevision ?? null,
    csvCall: lines[0]?.rawCall ?? null,
    csvVessel: lines[0]?.rawVessel ?? null,
    // 核验不通过的文件不向下游提供任何明细，避免错内容误入归属判定。
    lines: differences.length === 0 ? lines : [],
  };
}

// 一次完整收件：沿港区入口收集详情与下载；未出齐的页面只登记不阻断其它港区。
export async function collectFromPortal(client, store, options, hooks = {}) {
  const at = options.at;
  const log = hooks.log ?? (() => {});
  store.state.portal = { url: client.baseUrl, fetchedAt: at };
  await mkdir(client.downloadDir, { recursive: true });

  const home = await client.open('/west');
  if (home.status !== 200 || !home.page) {
    throw new Error(`港区入口无法打开（HTTP ${home.status}）`);
  }
  const areaLinks = home.page.links.filter(link => link.href.startsWith('/west/'));
  const summary = { areas: {}, documents: [], discrepancies: [] };

  for (const areaLink of areaLinks) {
    const area = areaFromPath(areaLink.href);
    store.noteArea(area, areaLink.href, at);
    const areaResult = { pages: [], cases: [], ready: true };
    summary.areas[area] = areaResult;
    const queue = [areaLink.href];
    const seenPages = new Set();

    while (queue.length > 0) {
      const path = queue.shift();
      if (seenPages.has(path)) continue;
      seenPages.add(path);
      const opened = await client.open(path);
      if (opened.status >= 400) {
        // 续页未出齐：登记缺口与重取入口，保持该港区未齐，不抛异常。
        store.notePage(area, path, at, opened.status, '页面暂不可用，等待续页发布后重取');
        areaResult.pages.push({ path, status: opened.status, missing: true });
        areaResult.ready = false;
        log(`港区 ${area} 页面 ${path} 返回 ${opened.status}，登记缺口稍后重取`);
        continue;
      }
      store.notePage(area, path, at, opened.status);
      areaResult.pages.push({ path, status: opened.status, missing: false });
      for (const link of opened.page.links) {
        if (link.href.startsWith('/case/')) areaResult.cases.push(link.href);
        else if (link.href.startsWith('/west/') && !seenPages.has(link.href)) queue.push(link.href);
      }
    }

    for (const casePath of [...new Set(areaResult.cases)]) {
      const detailPage = await client.open(casePath);
      if (detailPage.status !== 200 || !detailPage.page) {
        store.notePage(area, casePath, at, detailPage.status, '详情页暂不可用');
        areaResult.ready = false;
        continue;
      }
      const detail = parseCaseDetail(detailPage.page);
      const exportLink = detailPage.page.links.find(link => link.download);
      store.noteCase(casePath, {
        area, ...detail, caseUrl: casePath,
        exportUrl: exportLink?.href ?? null, seenAt: at,
      });
      if (!exportLink) {
        store.notePage(area, casePath, at, detailPage.status, '文件尚未生成，保留重取入口');
        areaResult.ready = false;
        continue;
      }

      const fetched = await client.triggerDownload(exportLink.href);
      const verification = verifyFetchedFile(fetched, detail);
      const safeName = fetched.filename.replace(/[^A-Za-z0-9._-]/g, '_');
      const savedPath = `${client.downloadDir}/${verification.sha256.slice(0, 12)}-${safeName}`;
      await writeFile(savedPath, fetched.bytes);

      const record = {
        caseUrl: casePath,
        exportUrl: exportLink.href,
        area,
        document: detail.document,
        revision: detail.revision,
        call: detail.call,
        vessel: detail.vessel,
        berth: detail.berth ?? null,
        agent: detail.agents[0] ?? null,
        agents: detail.agents,
        filename: fetched.filename,
        savedPath,
        sha256: verification.sha256,
        verified: verification.verified,
        lines: verification.verified ? verification.lines : [],
        differences: verification.differences,
        refetch: { exportUrl: exportLink.href, caseUrl: casePath },
        fetchedAt: at,
      };

      const exact = store.state.documents.find(doc => doc.sha256 === verification.sha256
        && doc.exportUrl === exportLink.href);
      if (!exact) {
        const id = store.addDocument(record);
        summary.documents.push(id);
        if (!verification.verified) {
          summary.discrepancies.push({ id, differences: verification.differences, refetch: record.refetch });
          log(`下载差异已留痕（${id}）：${verification.differences.join('；')}；重取入口 ${exportLink.href}`);
        }
      }
    }
  }
  return summary;
}
