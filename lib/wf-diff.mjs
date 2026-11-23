// 前后端校验差分（wf diffcheck）
//
// 解决的问题：本地 validateWorkflow 是「照线上行为写死的」，平台升级或规则漂移时
// 会悄悄失准（漏报/误报），但没人知道。这个模块用「造毒 → 推送 → 读前端诊断」做黑盒差分：
//
//   1. 取一份真实 workflow（--appId 读取，或 --file 指定）
//   2. 往副本里注入一组「已知缺陷」（每类对应一条本地规则）
//   3. 本地：跑 validateWorkflow，记录判定
//   4. 远端：建影子 app → 原样推送带毒 nodes（不经 normalize）→ headless 打开画布读诊断
//   5. 对比：哪些本地抓到/漏掉、哪些前端抓到/放行 —— 输出漂移位点
//
// 为什么不经 normalize：normalize 会提前「修好」问题（如 boolean→"true"），
// 导致 validate 看不到原始缺陷、误以为本地规则能抓。差分必须喂原始脏数据。

import { validateWorkflow } from './validate.mjs';
import { launchBrowser, waitUntil, sleep } from './browser.mjs';

/** 缺陷注入器：每条 = 一个探测点，带 id/desc/本地预期 */
export const DEFECTS = {
  isolated_edge: (wf) => {
    if (!wf.edges.length) return null;
    const removed = wf.edges.pop();
    return { desc: `删边 ${removed.source}->${removed.target}（孤立节点）`, localCode: 'isolated' };
  },
  bad_valuetype: (wf) => {
    for (const n of wf.nodes) {
      if (n.flowNodeType !== 'code') continue;
      for (const inp of n.inputs || []) {
        if (Array.isArray(inp.value) && inp.value.length === 2 && typeof inp.value[0] === 'string') {
          inp.valueType = 'number';
          return { desc: `节点 ${n.nodeId}.${inp.key} 引用 valueType 改 number`, localCode: 'valuetype' };
        }
      }
    }
    return null;
  },
  dead_ref_in_code: (wf) => {
    for (const n of wf.nodes) {
      if (n.flowNodeType !== 'code') continue;
      const inp = (n.inputs || []).find(i => i.key === 'code');
      if (!inp || typeof inp.value !== 'string') continue;
      inp.value = `const __bad = "{{$deadbeefdeadbeefdeadbeef.x$}}";\n` + inp.value;
      return { desc: `节点 ${n.nodeId} 代码埋入引用不存在节点`, localCode: 'bare_variable_ref' };
    }
    return null;
  },
  ifelse_bool: (wf) => {
    for (const n of wf.nodes) {
      if (n.flowNodeType !== 'ifElseNode') continue;
      const list = (n.inputs || []).find(i => i.key === 'ifElseList')?.value;
      if (Array.isArray(list) && list[0] && Array.isArray(list[0].list) && list[0].list[0]) {
        list[0].list[0].value = true;
        return { desc: `ifElse ${n.nodeId} 条件 value 设 boolean`, localCode: 'ifelse_value_type' };
      }
    }
    return null;
  },
  canedit_const: (wf) => {
    for (const n of wf.nodes) {
      if (n.flowNodeType !== 'code') continue;
      for (const inp of n.inputs || []) {
        if (inp.canEdit === true) {
          inp.value = 'hardcoded-const-probe';
          return { desc: `节点 ${n.nodeId}.${inp.key}(canEdit) 设常量`, localCode: 'canedit_const_value' };
        }
      }
    }
    return null;
  },
};

/**
 * 本地判定：给定带毒 workflow，跑 validateWorkflow，抽出命中的 issue codes。
 * 注意直接用 validateWorkflow（不经 normalize），才能看到原始缺陷。
 */
export function localJudge(wf) {
  const v = validateWorkflow({ nodes: wf.nodes, edges: wf.edges, chatConfig: wf.chatConfig });
  return {
    ok: v.ok,
    codes: [...new Set(v.issues.map(i => i.code))],
    issues: v.issues,
    // warnings 也要带出来：孤立节点、modelId 占位等属于 warning 而非 issue，
    // 只看 issues 会把「本地确实报了（只是当 warning）」误判成 local_miss。
    warnings: v.warnings,
    errorCount: v.errors.length,
    warningCount: v.warnings.length,
  };
}

/**
 * 远端判定：建影子 app → 推带毒 nodes → headless 读画布诊断 → 删影子 app。
 * @returns {Promise<{publishCode:number, publishMsg:string, offenders:Array, pendingCount:number,
 *                    badTexts:string[], canvasOk:boolean, rendered:number, skipped?:string}>}
 */
export async function remoteJudge({ base, token, fetchImpl, wf, headlessWait = 8000 }) {
  const H = { 'Content-Type': 'application/json', 'fastgpt-web-request': 'fastgpt', Cookie: `fastgpt_token=${token}` };
  const f = fetchImpl || fetch;

  // 建影子 app
  const cr = await (await f(`${base}/api/core/app/create`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ parentId: null, name: `zz-diffcheck-${Date.now()}`, type: 'advanced', avatar: 'core/app/type/workflowFill', intro: 'diffcheck' }),
  })).json();
  if (cr.code !== 200) throw new Error(`建影子 app 失败: ${JSON.stringify(cr).slice(0, 160)}`);
  const appId = cr.data;

  let result;
  try {
    const pr = await (await f(`${base}/api/core/app/version/publish?appId=${appId}`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ nodes: wf.nodes, edges: wf.edges, chatConfig: wf.chatConfig, isPublish: true, autoSave: true, versionName: 'diffcheck' }),
    })).json();
    const publishCode = pr.code;
    const publishMsg = pr.message || '';

    // 发布被服务端硬拒（如 modelId 无效）→ 记下但不读画布
    if (publishCode !== 200) {
      result = { publishCode, publishMsg, offenders: [], pendingCount: 0, badTexts: [], canvasOk: false, rendered: 0,
                 note: '服务端发布即拒，前端未渲染' };
      return result;
    }

    // 读画布
    const page = await launchBrowser({ base, token, tag: 'diffcheck' });
    if (page.skipped) return { publishCode, publishMsg, skipped: page.skipped, offenders: [], pendingCount: 0, badTexts: [], canvasOk: false, rendered: 0 };

    try {
      await page.navigate(`${base.replace(/\/$/, '')}/app/detail?appId=${appId}`);
      const probe = `(function(){return document.querySelectorAll('.react-flow__node').length;})()`;
      const w = await waitUntil(page, probe, v => typeof v === 'number' && v > 0, { tries: 40, intervalMs: 1000 });
      await sleep(3500); // 等诊断跑完

      const raw = await page.eval(`(function(){
        const t = document.body ? document.body.innerText : '';
        const offs = [];
        document.querySelectorAll('.react-flow__node').forEach(function(el){
          const lines = (el.innerText||'').split('\\n').map(function(s){return s.trim();}).filter(Boolean);
          const at = lines.findIndex(function(l){return l.indexOf('待完善')>=0 || l.indexOf('待处理')>=0;});
          if (at>=0){
            const issues = lines.slice(at+1).filter(function(l){return l.indexOf('待完善')<0 && l.indexOf('待处理')<0;});
            if (issues.length) offs.push({ nodeId: el.getAttribute('data-id')||'', title: lines[0]||'', issues: issues });
          }
        });
        const keys = ['存在未完成','输入变量配置','待完善','无效变量','不在同一流程作用域','未与其他节点连线','需填写必填','Model model is unavailable','不符合字段结构约束','无法渲染','渲染失败'];
        const bad = keys.filter(function(k){return t.indexOf(k)>=0;});
        return JSON.stringify({ offenders: offs, badTexts: bad, textLen: t.length });
      })()`);
      let p = {}; try { p = JSON.parse(raw || '{}'); } catch {}
      const offenders = p.offenders || [];
      const badTexts = p.badTexts || [];
      result = {
        publishCode, publishMsg,
        rendered: typeof w.value === 'number' ? w.value : 0,
        offenders, pendingCount: offenders.length, badTexts,
        canvasOk: offenders.length === 0 && badTexts.length === 0,
      };
    } finally { page.close(); }
    return result;
  } finally {
    // 清理影子 app
    try { await f(`${base}/api/core/app/del?appId=${appId}`, { method: 'DELETE', headers: H }); } catch {}
  }
}

/**
 * 把本地判定和远端判定对照，输出每个缺陷的命中差异。
 * @param {Array<{id,desc,localCode}>} injected
 * @param {object} local   localJudge 结果
 * @param {object} remote  remoteJudge 结果
 */
export function reconcile(injected, local, remote) {
  const localCodes = new Set(local.codes || []);
  // 本地文本证据：issues 的 message + warnings（孤立节点等只在 warning 里）
  const localText = [
    ...(local.issues || []).map(i => i.message || ''),
    ...(local.warnings || []),
  ].join(' | ');
  // 远端证据：offender 的 issues 文本 + badTexts + publishMsg
  const remoteText = [
    ...(remote.offenders || []).flatMap(o => o.issues || []),
    ...(remote.badTexts || []),
    remote.publishMsg || '',
  ].join(' | ');

  // 本地是否命中：先看 issue code，再退回关键词（覆盖 warning 类规则）
  const localHitOf = (d) => {
    if (d.localCode && localCodes.has(d.localCode)) return true;
    if (d.id === 'isolated_edge') return /孤立|没有任何入边|没有任何连线/.test(localText);
    if (d.id === 'canedit_const') return /canedit|未完成的输入变量配置/.test(localText);
    if (d.id === 'ifelse_bool') return /ifElse|ifelse/.test(localText);
    if (d.id === 'bad_valuetype') return /valueType|类型不符/.test(localText);
    if (d.id === 'dead_ref_in_code') return /无效变量|不存在于|引用/.test(localText);
    return false;
  };

  return injected.map(d => {
    const localHit = localHitOf(d);
    // 远端是否"看见"这个问题：粗判——缺陷类型对应关键词出现在远端诊断里
    let remoteHit = null;
    if (remote.publishCode && remote.publishCode !== 200) remoteHit = true; // 发布被拒 = 远端硬拦
    else if (remoteText) {
      if (d.id === 'isolated_edge') remoteHit = /未与其他节点连线|需填写必填/.test(remoteText);
      else if (d.id === 'ifelse_bool') remoteHit = /不符合字段结构约束|ifElseList/.test(remoteText);
      else if (d.id === 'canedit_const' || d.id === 'bad_valuetype') remoteHit = /存在未完成|输入变量配置|选择引用变量/.test(remoteText);
      else if (d.id === 'dead_ref_in_code') remoteHit = /无效变量/.test(remoteText);
      else remoteHit = remote.offenders.length > 0;
    }
    return {
      id: d.id, desc: d.desc, localCode: d.localCode,
      localHit, remoteHit,
      // 关键位点：本地漏 / 远端抓 = 本地规则不足；本地抓 / 远端放 = 本地可能误报
      drift: localHit === false && remoteHit === true ? 'local_miss'
           : localHit === true && remoteHit === false ? 'local_over'
           : null,
    };
  });
}
