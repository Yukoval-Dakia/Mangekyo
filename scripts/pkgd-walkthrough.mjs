// 改进包 D1+D3 走查：课堂等待进度、AI 运作 blocked/用量、同伴 unknown 恢复引导
// 用法: node scripts/pkgd-walkthrough.mjs <baseUrl> <outDir> <roomId> <sessionId>
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4491';
const OUT = process.argv[3] ?? 'docs/evidence/web-m3e-pkg-d';
const ROOM = process.argv[4] ?? 'F8CBA6B131008B452CEE6ED337';
const SESSION = process.argv[5] ?? 'E5FD69840AB34B48C7315617EF';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9225;
const PROFILE = join(tmpdir(), `pkgd-chrome-${process.pid}`);

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

  const shot = async (name, {url, width = 1440, height = 900, theme = 'light', actions = [], waits = 2200}) => {
    const tab = await newTab('about:blank');
    const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 500});
    await cdp.send('Page.navigate', {url: BASE + '/today'});
    await sleep(700);
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('mangekyo:theme','${theme}');document.documentElement.dataset.theme='${theme}';`,
    });
    await cdp.send('Page.navigate', {url: BASE + url});
    await sleep(waits);
    for (const action of actions) {
      if (action.eval) await cdp.send('Runtime.evaluate', {expression: action.eval});
      if (action.wait) await sleep(action.wait);
    }
    const consoleErrors = cdp.events.filter(
      e => e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'),
    );
    const {result: scrollResult} = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth,scrollH:document.documentElement.scrollHeight})`,
      returnByValue: true,
    });
    const {result: textResult} = await cdp.send('Runtime.evaluate', {
      expression: `document.body.innerText.slice(0, 4000)`,
      returnByValue: true,
    });
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
    const metrics = JSON.parse(scrollResult.value ?? '{}');
    const overflow = metrics.scrollW > metrics.clientW;
    results.push({
      name, url, theme, width,
      consoleErrors: consoleErrors.length,
      errorTexts: consoleErrors.slice(0, 3).map(e => JSON.stringify(e.params).slice(0, 300)),
      overflow, scrollW: metrics.scrollW, clientW: metrics.clientW,
      text: (textResult.value ?? '').replace(/\n{2,}/g, '\n').slice(0, 1200),
    });
    console.log(`${name}: errors=${consoleErrors.length} overflow=${overflow}`);
    cdp.ws.close();
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${tab.id}`);
  };

  const openDrawer = `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-pressed')!==null&&b.textContent.includes('AI 运作'))?.click()`;

  await shot('01-classroom-waiting-progress-light.png', {url: `/classroom/${ROOM}`, waits: 3500});
  await shot('02-classroom-waiting-progress-dark.png', {url: `/classroom/${ROOM}`, theme: 'dark', waits: 3000});
  await shot('03-ai-activity-blocked-usage.png', {
    url: '/today',
    actions: [{eval: openDrawer}, {wait: 1800}],
  });
  await shot('04-companion-unknown-recovery.png', {url: `/companion?session=${SESSION}`, waits: 3000});
  await shot('05-ai-activity-dark.png', {
    url: '/today', theme: 'dark',
    actions: [{eval: openDrawer}, {wait: 1800}],
  });
  await shot('06-classroom-progress-mobile.png', {url: `/classroom/${ROOM}`, width: 390, height: 844, waits: 3000});
  await shot('07-companion-unknown-mobile.png', {url: `/companion?session=${SESSION}`, width: 390, height: 844, waits: 3000});
  await shot('08-ai-activity-mobile.png', {
    url: '/today', width: 390, height: 844,
    actions: [{eval: `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-pressed')!==null&&b.textContent.includes('AI 运作'))?.click()`}, {wait: 1800}],
  });
  await shot('09-companion-drawer-unknown.png', {
    url: '/today',
    actions: [
      {eval: `[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-pressed')!==null&&b.textContent.includes('学习同伴'))?.click()`},
      {wait: 1200},
      {eval: `[...document.querySelectorAll('.drawer-card-button')].find(b=>b.textContent.includes('二次函数'))?.click()`},
      {wait: 1800},
    ],
  });
  await shot('10-privacy-nav.png', {
    url: `/companion?session=${SESSION}`,
    actions: [
      {eval: `[...document.querySelectorAll('a')].find(a=>a.textContent.includes('前往开启工作区权限'))?.click()`},
      {wait: 1600},
    ],
    waits: 3000,
  });

  writeFileSync(join(OUT, 'walkthrough.json'), JSON.stringify({base: BASE, room: ROOM, session: SESSION, at: new Date().toISOString(), results}, null, 2));
  console.log('\n汇总:', JSON.stringify(results.map(r => ({name: r.name, errors: r.consoleErrors, overflow: r.overflow})), null, 1));
  chrome.kill('SIGTERM');
  process.exit(0);
}

run().catch(error => { console.error(error); cleanup(); process.exit(1); });
