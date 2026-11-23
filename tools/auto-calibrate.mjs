#!/usr/bin/env node
// 自动校准（calibrate 的 step 1-3 全自动）：扣前端 chunk → 抽诊断码枚举 → 与本地比对 diffsets
//
// 用法：
//   node tools/auto-calibrate.mjs --base https://cloud.fastgpt.cn [--out drift.json]
//
// 前提：本机有 Chrome + ~/.fastgpt/cookies.json 里有 fastgpt_token（与 ui-check 同一份）。
// 它做的是「扣枚举」这一半——能 100% 自动。校验逻辑（判定条件）在服务端，扣不到，靠人工映射。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (arg('--base', 'https://cloud.fastgpt.cn')).replace(/\/$/, '');
const OUT = arg('--out', '');

const CHROME = [
  process.env.FGPT_CHROME || '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('未找到 Chrome，可用 FGPT_CHROME 指定'); process.exit(1); }

const cookieFile = join(homedir(), '.fastgpt', 'cookies.json');
if (!existsSync(cookieFile)) { console.error('缺少 ~/.fastgpt/cookies.json（先 fastgpt auth）'); process.exit(1); }
const token = JSON.parse(readFileSync(cookieFile, 'utf8')).fastgpt_token;
if (!token) { console.error('cookies.json 里没有 fastgpt_token'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 起隔离 headless chrome，CDP 连上后抓 performance resource 里所有 .js URL
async function collectChunkUrls() {
  const port = 9400 + Math.floor(Math.random() * 80);
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/fg-cal-${port}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };

  try {
    let info = null;
    for (let i = 0; i < 60; i++) {
      try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    if (!info) throw new Error('Chrome 未就绪');

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, sessionId })); return new Promise((res, rej) => pending.set(i, { res, rej })); };

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Network.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    const host = BASE.replace(/^https?:\/\//, '');
    for (const domain of [`.${host}`, host]) {
      try { await send('Network.setCookie', { name: 'fastgpt_token', value: token, domain, path: '/', secure: BASE.startsWith('https'), httpOnly: false }, sessionId); } catch {}
    }

    // 打开任意工作流编辑器页会触发校验相关 chunk 加载；首页先兜底
    await send('Page.navigate', { url: `${BASE}/dashboard/agent` }, sessionId);
    await sleep(12000);

    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>u.endsWith('.js')))`,
      returnByValue: true,
    }, sessionId);
    return JSON.parse(r.result.value || '[]');
  } finally { cleanup(); }
}

async function main() {
  console.error(`① 抓取 ${BASE} 的前端 chunk URL…`);
  const urls = await collectChunkUrls();
  console.error(`   拿到 ${urls.length} 个 js chunk`);

  // ② 下载并 grep 所有 WORKFLOW_* 诊断码（这是前端 chunk 里唯一能可靠扣到的"逻辑外知识"）
  const found = new Set();
  let scanned = 0;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Cookie: `fastgpt_token=${token}` } });
      if (!r.ok) continue;
      const t = await r.text();
      scanned++;
      for (const m of t.matchAll(/['"]?(WORKFLOW_[A-Z0-9_]+)['"]?/g)) found.add(m[1]);
    } catch {}
  }
  console.error(`② 扫描 ${scanned} 个 chunk，抽到 ${found.size} 个 WORKFLOW_* 诊断码`);

  // ③ 与本地 ruleset.mjs 的 DIAGNOSTIC_CODES 比对
  const { DIAGNOSTIC_CODES, CALIBRATED_WITH } = await import(join(ROOT, 'lib', 'ruleset.mjs'));
  const local = new Set(DIAGNOSTIC_CODES);
  const added = [...found].filter(c => !local.has(c)).sort();   // 平台新增、本地不认识的
  const missing = [...local].filter(c => !found.has(c)).sort(); // 本地有、该实例没有的（可能被删/版本不同）

  const report = {
    base: BASE, scannedChunks: scanned,
    calibratedWith: CALIBRATED_WITH,
    remoteCodeCount: found.size, localCodeCount: local.size,
    newOnServer: added,          // ← 这些是「平台新增规则我不知道」的洞
    missingOnServer: missing,
    // step 4 仍是人工：把 newOnServer 补进 DIAGNOSTIC_CODES，再看是否要加校验
    nextActions: added.length
      ? [`把以下码补进 lib/ruleset.mjs 的 DIAGNOSTIC_CODES：${added.join(', ')}`,
         '逐个判断：是否对应 validate.mjs 里需要新增的检查（这步扣不到，必须读服务端行为/抓诊断码触发条件反推）',
         `更新 CALIBRATED_WITH 为目标实例的 systemVersion`]
      : ['本地枚举已覆盖该实例，无需补码'],
  };

  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
