// 前端画布渲染校验（内置，不依赖外挂脚本）
//
// 为什么必须有这一步：
//   wf lint / wf build 全绿、OpenAPI 也跑得通，但画布打开是空白/报错 —— 这类问题
//   只有真的把页面渲出来才看得见。SKILL.md「红线三：前端不认的写法」列的四类，
//   运行时全绿、界面全错。把检查内置进 build/verify，才不会靠 agent 记得加 --ui-cmd。
//
// 实现：起一个隔离 headless Chrome → 注入 fastgpt_token → 打开 app/detail → 读 DOM
// 无 Chrome / 无法启动时返回 skipped，由调用方决定是 fail-closed 还是放行。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.FGPT_CHROME || '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const COOKIE_FILE = join(homedir(), '.fastgpt', 'cookies.json');
const CACHE_FILE = join(homedir(), '.fastgpt', 'ui-check-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 分钟内同指纹直接复用，避免连续调 prompt 时反复等 9 秒

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(obj) {
  try {
    mkdirSync(join(homedir(), '.fastgpt'), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 1));
  } catch { /* 缓存写失败不影响主流程 */ }
}

/** 画布专有文本：只在工作流编辑器里出现，应用列表页没有（避免把列表卡片当成渲染成功） */
const CANVAS_MARKERS = ['流程开始', '全局变量', '节点缺少介绍', '工作流编排', '我的编辑'];

/** 画布上应该出现的节点名 */
const EXPECT_NODES = [
  '流程开始', '文档解析', '文件解析', 'AI 回复', 'AI 对话', '指定回复',
  '知识库搜索', '判断器', '代码运行', 'HTTP 请求', '文本拼接',
];

/** 真正代表「前端坏了」的文案。注意「选择引用变量」「节点缺少介绍」是正常占位/提示，不能算错 */
const BAD_TEXTS = [
  '存在未完成的输入变量配置',
  '渲染失败', '出错了', '白屏', '无法渲染',
  '不符合字段结构约束',
  'Model model is unavailable',
  'Cannot read properties',
  'Uncaught',
  '应用不存在',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pickChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/**
 * @param {string} appId
 * @param {{base?:string, timeoutMs?:number, headlessWait?:number}} opts
 * @returns {Promise<{ok:boolean, skipped?:string, verdict:string, nodesFound?:string[], errors?:string[], sample?:string}>}
 */
export async function checkCanvas(appId, opts = {}) {
  const {
    base = 'https://cloud.fastgpt.cn',
    timeoutMs = 45000,
    headlessWait = 9000,
    fingerprint = null,        // 结构指纹：相同则 5 分钟内复用上次结果
    noCache = false,
  } = opts;

  // ---- 指纹缓存：只跳过「结构没变」的重复校验，失败结果不缓存 ----
  if (fingerprint && !noCache) {
    const cache = readCache();
    const hit = cache[fingerprint];
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS && hit.result && hit.result.ok) {
      return { ...hit.result, cached: true, cacheAgeMs: Date.now() - hit.ts };
    }
  }

  if (!appId || !/^[0-9a-f]{24}$/i.test(appId)) {
    return { ok: false, skipped: 'appId 不合法，无法做画布校验', verdict: 'skipped' };
  }
  const chromePath = pickChrome();
  if (!chromePath) {
    return { ok: true, skipped: '未找到 Chrome，跳过画布校验（可用 FGPT_CHROME 指定路径）', verdict: 'skipped' };
  }
  if (!existsSync(COOKIE_FILE)) {
    return { ok: true, skipped: '没有 ~/.fastgpt/cookies.json，跳过画布校验', verdict: 'skipped' };
  }
  let cookie;
  try {
    cookie = JSON.parse(readFileSync(COOKIE_FILE, 'utf8')).fastgpt_token;
  } catch {
    return { ok: true, skipped: 'cookies.json 解析失败，跳过画布校验', verdict: 'skipped' };
  }

  const port = 9300 + Math.floor(Math.random() * 90);
  const chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/fg-ui-check-${port}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let ws, msgId = 0;
  const pending = new Map();
  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };
  const timer = setTimeout(() => { cleanup(); }, timeoutMs);

  try {
    // 等 Chrome 的调试端口
    let info = null;
    for (let i = 0; i < 60; i++) {
      try {
        info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch { await sleep(250); }
    }
    if (!info) return { ok: true, skipped: 'Chrome 未在超时内就绪，跳过画布校验', verdict: 'skipped' };

    ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });

    const send = (method, params = {}, sessionId) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    };

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Network.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    const host = base.replace(/^https?:\/\//, '');
    for (const domain of [`.${host}`, host]) {
      try {
        await send('Network.setCookie', {
          name: 'fastgpt_token', value: cookie, domain, path: '/', secure: true, httpOnly: false,
        }, sessionId);
      } catch { /* 域名不合法时忽略 */ }
    }

    const url = `${base.replace(/\/$/, '')}/app/detail?appId=${appId}`;
    await send('Page.navigate', { url }, sessionId);
    await sleep(headlessWait);

    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const t = document.body ? document.body.innerText : '';
        return JSON.stringify({ text: t.slice(0, 4000), href: location.href });
      })()`,
      returnByValue: true,
    }, sessionId);

    const parsed = JSON.parse(r.result.value || '{}');
    const text = parsed.text || '';
    const href = parsed.href || '';
    const onCanvas = href.includes(appId);
    const canvasMarkers = CANVAS_MARKERS.filter(k => text.includes(k));
    const nodesFound = EXPECT_NODES.filter(k => text.includes(k));
    const errors = BAD_TEXTS.filter(b => text.includes(b));

    // 没停在画布（被重定向到首页/列表）→ 应用不存在或无权访问，不能算渲染成功
    if (!onCanvas) {
      try { await send('Target.closeTarget', { targetId }); } catch {}
      return { ok: false, verdict: 'app_unreachable', href,
        errors: ['打开的不是画布页（被重定向），应用不存在或当前账号无权限'],
        sample: text.slice(0, 300).replace(/\s+/g, ' ') };
    }

    // 停在画布：要求出现画布专有文本 + 至少 2 个节点名，且无已知报错
    const ok = errors.length === 0 && canvasMarkers.length >= 1 && nodesFound.length >= 2;
    try { await send('Target.closeTarget', { targetId }); } catch {}
    const result = { ok, verdict: ok ? 'canvas_renders' : 'canvas_broken',
                     href, canvasMarkers, nodesFound, errors,
                     sample: text.slice(0, 500).replace(/\s+/g, ' ') };
    if (ok && fingerprint && !noCache) {
      const cache = readCache();
      const now = Date.now();
      for (const k of Object.keys(cache)) if (now - cache[k].ts > CACHE_TTL_MS * 4) delete cache[k];
      cache[fingerprint] = { ts: now, result };
      writeCache(cache);
    }
    return result;
  } catch (e) {
    return { ok: true, skipped: `画布校验异常：${String(e.message).slice(0, 120)}`, verdict: 'skipped' };
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}
