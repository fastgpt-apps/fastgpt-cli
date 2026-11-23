// 前端画布渲染校验（内置，不依赖外挂脚本）
//
// 为什么必须有这一步：
//   wf lint / wf build 全绿、OpenAPI 也跑得通，但画布打开是空白/报错 —— 这类问题
//   只有真的把页面渲出来才看得见。SKILL.md「红线三：前端不认的写法」列的四类，
//   运行时全绿、界面全错。把检查内置进 build/verify，才不会靠 agent 记得加 --ui-cmd。
//
// 实现：起一个隔离 headless Chrome → 注入 fastgpt_token → 打开 app/detail → 读 DOM。
//   Chrome/CDP 的启动、cookie 注入、导航、eval 都交给 lib/browser.mjs 公共引擎，
//   本模块只负责「打开画布 + 读 DOM + 判定」，与 wf diffcheck 共用同一套浏览器引擎。
//
// 无 Chrome / 无法启动时返回 skipped，由调用方决定是 fail-closed 还是放行。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser, waitUntil, readToken, sleep } from './browser.mjs';
import { HOME } from './account.mjs';

const CACHE_FILE = join(HOME, 'ui-check-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 分钟内同指纹直接复用，避免连续调 prompt 时反复等 9 秒

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(obj) {
  try {
    mkdirSync(HOME, { recursive: true });
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
  '需填写必填项',                 // ★ 输入未绑定
  '无效变量',                     // ★ prompt 引用了不存在的输出
  '不在同一流程作用域',           // ★ 容器子节点缺 parentNodeId
  '未与其他节点连线',             // ★ 节点孤立
  '渲染失败', '出错了', '白屏', '无法渲染',
  '不符合字段结构约束',
  'Model model is unavailable',
  'Cannot read properties',
  'Uncaught',
  '应用不存在',
];

/**
 * @param {string} appId
 * @param {{base?:string, timeoutMs?:number, headlessWait?:number, fingerprint?:string|null, noCache?:boolean}} opts
 * @returns {Promise<{ok:boolean, skipped?:string, verdict:string, nodesFound?:string[], errors?:string[], sample?:string, offenders?:Array, pendingCount?:number, cached?:boolean}>}
 */
export async function checkCanvas(appId, opts = {}) {
  const {
    base = 'https://cloud.fastgpt.cn',
    timeoutMs = 45000,
    headlessWait = 8000,
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
  if (!readToken()) {
    return { ok: true, skipped: '没有 ~/.fastgpt/cookies.json，跳过画布校验', verdict: 'skipped' };
  }

  // 起浏览器（公共引擎）。起不来就 fail-open 跳过。
  const deadline = Date.now() + timeoutMs;
  const page = await launchBrowser({ base, tag: 'ui-check' });
  if (page.skipped) {
    return { ok: true, skipped: `跳过画布校验：${page.skipped}（可用 FGPT_CHROME 指定路径）`, verdict: 'skipped' };
  }

  try {
    const url = `${base.replace(/\/$/, '')}/app/detail?appId=${appId}`;
    await page.navigate(url);

    // 轮询等画布渲染（React Flow 节点出现），用剩余时间预算，避免死等。
    const baseWait = Math.min(headlessWait, Math.max(0, deadline - Date.now()));
    if (baseWait > 0) await sleep(baseWait);

    const probeExpr = `(() => {
      const h = location.href;
      const nodes = document.querySelectorAll('.react-flow__node').length;
      return JSON.stringify({ h, nodes });
    })()`;
    const rendered = await waitUntil(page, probeExpr,
      v => { try { const p = JSON.parse(v); return p.h && p.h.includes(appId) && p.nodes > 0; } catch { return false; } },
      { tries: 12, intervalMs: 1000 });

    // 一次性读取：页面文本 + 逐节点 offender + 全局诊断关键词
    const readExpr = `(() => {
      const t = document.body ? document.body.innerText : '';
      const offs = [];
      document.querySelectorAll('.react-flow__node').forEach(el => {
        const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        const at = lines.findIndex(l => l.includes('待完善') || l.includes('待处理'));
        if (at >= 0) {
          const issues = lines.slice(at + 1).filter(l => !l.includes('待完善') && !l.includes('待处理'));
          if (issues.length) offs.push({
            nodeId: el.getAttribute('data-id') || '',
            title: lines[0] || '',
            issues,
          });
        }
      });
      return JSON.stringify({
        text: t, href: location.href, offenders: offs,
        nodeCount: document.querySelectorAll('.react-flow__node').length,
      });
    })()`;
    const raw = await page.eval(readExpr);
    let parsed = {};
    try { parsed = JSON.parse(raw || '{}'); } catch {}

    const text = parsed.text || '';
    const href = parsed.href || '';
    const onCanvas = href.includes(appId);
    const canvasMarkers = CANVAS_MARKERS.filter(k => text.includes(k));
    const nodesFound = EXPECT_NODES.filter(k => text.includes(k));
    const errors = BAD_TEXTS.filter(b => text.includes(b));
    const offenders = parsed.offenders || [];
    const pendingCount = offenders.length;

    // 没停在画布（被重定向到首页/列表）→ 应用不存在或无权访问，不能算渲染成功
    if (!onCanvas) {
      return { ok: false, verdict: 'app_unreachable', href,
        errors: ['打开的不是画布页（被重定向），应用不存在或当前账号无权限'],
        sample: text.slice(0, 300).replace(/\s+/g, ' ') };
    }

    // 停在画布：要求出现画布专有文本 + 至少 2 个节点名 + 无已知报错 + 无待完善
    // 「待完善」出现 = FastGPT 自己的节点健康检查不通过，这比猜节点名可靠得多
    const hasPending = pendingCount > 0 || /待完善/.test(text);
    const ok = errors.length === 0 && canvasMarkers.length >= 1 && nodesFound.length >= 2 && !hasPending;
    const result = {
      ok,
      verdict: ok ? 'canvas_renders' : (hasPending ? 'canvas_pending' : 'canvas_broken'),
      href, canvasMarkers, nodesFound, errors,
      pendingCount, offenders,
      nodeCount: parsed.nodeCount || 0,
      sample: text.slice(0, 500).replace(/\s+/g, ' '),
    };

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
    page.close();
  }
}
