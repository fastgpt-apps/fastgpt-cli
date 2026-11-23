// 公共 headless Chrome + CDP 引擎
//
// 为什么要抽出来：ui-check（画布渲染校验）和 wf diffcheck（前后端校验差分）
// 都需要「起一个隔离无头 Chrome → 注入 fastgpt_token → 打开页面 → 执行 JS/读 DOM」。
// 之前 ui-check 自己写了一份；差分测试又抄了一份（frontend_diff.mjs）。重复即漂移，
// 改成单一引擎，两边共用。
//
// 设计要点：
//   · 零依赖：用 Node 22+ 全局 WebSocket + fetch，不引 puppeteer/playwright
//   · 隔离：每个实例独立 --user-data-dir=/tmp/fg-<tag>-<port>，跑完 SIGKILL + 删目录
//   · fail-open：拿不到 Chrome / 起不来 → 返回 {engine:null, skipped}，由调用方决定放行
//   · 只做「连接 + 导航 + eval」，不掺业务判断，业务留给上层

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME } from './account.mjs';

const CHROME_CANDIDATES = [
  process.env.FGPT_CHROME || '',
  process.env.CHROME_PATH || '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export const COOKIE_FILE = join(HOME, 'cookies.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 找到可用的 Chrome 可执行文件，找不到返回 null */
export function pickChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

/** 读 fastgpt_token；读不到返回 null（调用方决定是否跳过） */
export function readToken() {
  try {
    const j = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
    return j.fastgpt_token || null;
  } catch {
    return null;
  }
}

/**
 * 极简 CDP 客户端（沿用 auth.mjs 的无依赖思路）。
 * 只封装本模块要用的 send/close。
 */
export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * 起一个隔离无头 Chrome，连上 CDP，建 target + 注入 cookie。
 *
 * @param {object} opts
 * @param {string} opts.base        目标实例地址，如 https://cloud.fastgpt.cn（用于 cookie domain）
 * @param {string} [opts.token]     fastgpt_token；不传则从 ~/.fastgpt/cookies.json 读
 * @param {string} [opts.tag]       临时目录前缀，便于排查
 * @param {number} [opts.waitMs]    等调试端口就绪的上限，默认 15000
 * @param {number} [opts.portBase]  调试端口起始，默认 9300（随机往后 200）
 * @returns {Promise<{ok:boolean, skipped?:string, cdp?:CDP, sessionId?:string, targetId?:string,
 *                    close:()=>void, navigate:(url:string)=>Promise<void>,
 *                    eval:(expr:string)=>Promise<any>}>}
 */
export async function launchBrowser(opts = {}) {
  const {
    base = 'https://cloud.fastgpt.cn',
    token: tokenIn,
    tag = 'browser',
    waitMs = 15000,
    portBase = 9300,
  } = opts;

  const noop = async () => {};
  const chromePath = pickChrome();
  if (!chromePath) return { ok: true, skipped: '未找到 Chrome', close: noop, navigate: noop, eval: noop };

  const token = tokenIn ?? readToken();
  const port = portBase + Math.floor(Math.random() * 200);
  const profile = join(tmpdir(), `fg-${tag}-${port}`);

  let chrome;
  try {
    chrome = spawn(chromePath, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--window-size=1680,1050', 'about:blank',
    ], { stdio: 'ignore' });
  } catch (e) {
    return { ok: true, skipped: `Chrome 启动失败：${e.message}`, close: noop, navigate: noop, eval: noop };
  }

  let closed = false;
  const cleanup = () => {
    if (closed) return; closed = true;
    try { chrome.kill('SIGKILL'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  const fail = reason => { cleanup(); return { ok: true, skipped: reason, close: noop, navigate: noop, eval: noop }; };

  // 等调试端口
  let info = null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!info) return fail('Chrome 调试端口未在超时内就绪');

  let cdp;
  try {
    cdp = new CDP(info.webSocketDebuggerUrl);
    await cdp.ready;
  } catch (e) {
    return fail(`CDP 连接失败：${e.message}`);
  }

  let targetId, sessionId;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
  } catch (e) {
    cleanup();
    return { ok: true, skipped: `CDP 初始化失败：${e.message}`, close: noop, navigate: noop, eval: noop };
  }

  // 注入 cookie（带 token 时）。域名两种写法都试，失败忽略。
  if (token) {
    const host = base.replace(/^https?:\/\//, '');
    const secure = base.startsWith('https');
    for (const domain of [`.${host}`, host]) {
      try {
        await cdp.send('Network.setCookie', { name: 'fastgpt_token', value: token, domain, path: '/', secure }, sessionId);
      } catch {}
    }
  }

  const navigate = async url => {
    try { await cdp.send('Page.navigate', { url }, sessionId); } catch {}
  };
  const evalJs = async expression => {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      return r.result ? r.result.value : undefined;
    } catch { return undefined; }
  };

  return {
    ok: true, cdp, sessionId, targetId,
    navigate, eval: evalJs,
    close: () => { try { cdp.send('Target.closeTarget', { targetId }); } catch {} cdp.close?.(); cleanup(); },
  };
}

/**
 * 轮询直到 predicate(evalJs 结果) 为真或超时。返回最后一次结果。
 * 用于"等编辑器渲染出节点"这类场景，替代死等固定秒数。
 */
export async function waitUntil(page, probeExpr, predicate, { tries = 40, intervalMs = 1000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await page.eval(probeExpr);
    if (predicate(last)) return { hit: true, value: last, tries: i + 1 };
    await sleep(intervalMs);
  }
  return { hit: false, value: last, tries };
}

export { sleep };
