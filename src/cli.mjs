#!/usr/bin/env node
// 收件与交接命令行：状态文件保证门户换页/重登/进程重启后接着收、接着发。
import { join } from 'node:path';
import { IntakeApp, loadAgencies } from './app.mjs';
import { Store } from './store.mjs';

const args = process.argv.slice(2);
const command = args.shift();

function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1];
}

const stateFile = option('state', join(process.cwd(), 'work/state.json'));
const downloadDir = option('downloads', join(process.cwd(), 'work/downloads'));
const agenciesFile = option('agencies', join(process.cwd(), 'data/agencies.json'));
const baseUrl = option('url', process.env.SOURCE_URL ?? 'http://127.0.0.1:4180');
const clock = () => new Date().toISOString();

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const store = await Store.open(stateFile);
  const agencies = await loadAgencies(agenciesFile);
  const app = new IntakeApp({
    store,
    agencies,
    downloadDir,
    log: message => process.stderr.write(`${message}\n`),
  });

  switch (command) {
    case 'collect': {
      print(await app.collect(baseUrl, clock()));
      break;
    }
    case 'send': {
      const only = option('claims');
      const claims = only ? only.split(',').map(id => store.state.claims
        .find(claim => claim.claimId === id)).filter(Boolean) : undefined;
      print(await app.send(baseUrl, { at: clock(), claims }));
      break;
    }
    case 'reconcile': {
      print(await app.reconcile(baseUrl, { at: clock() }));
      break;
    }
    case 'reverse': {
      const claimId = option('claim');
      if (!claimId) throw new Error('reverse 需要 --claim <claimId>');
      print(await app.reverse(baseUrl, claimId, { at: clock() }));
      break;
    }
    case 'view': {
      const project = option('project');
      print(project ? app.projectView(project) : app.managementView());
      break;
    }
    case 'impact': {
      const document = option('document');
      const revision = Number(option('revision'));
      if (!document || !revision) throw new Error('impact 需要 --document <号> --revision <数字>');
      print(app.impact(document, revision));
      break;
    }
    default:
      process.stderr.write([
        '用法：node src/cli.mjs <命令> [选项]',
        '命令：collect | send | reconcile | reverse | view | impact',
        '选项：--state --downloads --agencies --url --project --claim --document --revision --claims',
      ].join('\n') + '\n');
      process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
