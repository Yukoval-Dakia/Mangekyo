// Wave 2A 材料面走查：headless Chrome CDP 截图 + console 采集
// 用法: node scripts/wave2a-walkthrough.mjs <baseUrl> <outDir>
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4319';
const OUT = process.argv[3] ?? 'docs/evidence/web-m3e-wave2a';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9223;
const PROFILE = join(tmpdir(), `wave2a-chrome-${process.pid}`);

mkdirSync(OUT, {recursive: true});

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  'about:blank',
], {stdio: 'ignore'});

const cleanup = () => { try { chrome.kill('SIGTERM'); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    const cdp = new CDP(ws);
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && cdp.pending.has(msg.id)) {
        const {resolve, reject} = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        cdp.events.push(msg);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }
}

async function newTab(url) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, {method: 'PUT'});
  return res.json();
}

async function run() {
  await waitForDevtools();
  const results = [];

  const shot = async (name, {url, width = 1440, height = 900, theme = 'light', actions = []}) => {
    const tab = await newTab('about:blank');
    const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 500});
    // 强制该 tab 的 localStorage theme，避免 tab 之间串主题
    await cdp.send('Page.navigate', {url: BASE + '/today'});
    await sleep(700);
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('mangekyo:theme','${theme}');document.documentElement.dataset.theme='${theme}';`,
    });
    await cdp.send('Page.navigate', {url: BASE + url});
    await sleep(2200);
    for (const action of actions) {
      if (action.eval) await cdp.send('Runtime.evaluate', {expression: action.eval});
      if (action.wait) await sleep(action.wait);
    }
    const consoleErrors = cdp.events.filter(
      e => e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'),
    );
    const {result: scrollResult} = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth,scrollH:document.documentElement.scrollHeight,body:document.body?document.body.scrollWidth:0})`,
      returnByValue: true,
    });
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
    const metrics = JSON.parse(scrollResult.value ?? '{}');
    const overflow = metrics.scrollW > metrics.clientW;
    results.push({name, url, theme: theme ?? 'light', width, consoleErrors: consoleErrors.length, overflow, scrollW: metrics.scrollW, clientW: metrics.clientW});
    console.log(`${name}: errors=${consoleErrors.length} overflow=${overflow} ${metrics.scrollW}x${metrics.scrollH}`);
    cdp.ws.close();
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${tab.id}`);
  };

  await shot('01-materials-graph-desktop-light.png', {url: '/materials?tab=graph'});
  await shot('02-materials-graph-tree.png', {
    url: '/materials?tab=graph',
    actions: [{eval: `[...document.querySelectorAll('.kg-segment-btn')].find(b=>b.textContent.includes('树状'))?.click()`}, {wait: 900}],
  });
  await shot('03-materials-bank-desktop-light.png', {url: '/materials?tab=bank'});
  await shot('04-materials-bank-cite-companion.png', {
    url: '/materials?tab=graph',
    actions: [
      // 点击一个图谱节点打开详情，再点「引用到学习同伴」滑出抽屉
      {eval: `document.querySelector('.kg-node')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`},
      {wait: 900},
      {eval: `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('引用到学习同伴'))?.click()`},
      {wait: 1400},
    ],
  });
  await shot('05-materials-textbooks.png', {url: '/materials?tab=textbooks'});
  await shot('06-materials-papers.png', {url: '/materials?tab=papers'});
  await shot('07-materials-originals.png', {url: '/materials?tab=originals'});
  await shot('08-materials-dark-graph.png', {url: '/materials?tab=graph', theme: 'dark'});
  await shot('09-materials-mobile-bank.png', {url: '/materials?tab=bank', width: 390, height: 844});
  await shot('10-materials-mobile-graph.png', {url: '/materials?tab=graph', width: 390, height: 844});

  writeFileSync(join(OUT, 'walkthrough.json'), JSON.stringify({base: BASE, at: new Date().toISOString(), results}, null, 2));
  console.log('\n汇总:', JSON.stringify(results.map(r => ({name: r.name, errors: r.consoleErrors, overflow: r.overflow})), null, 1));
  chrome.kill('SIGTERM');
  process.exit(0);
}

run().catch(error => { console.error(error); cleanup(); process.exit(1); });
