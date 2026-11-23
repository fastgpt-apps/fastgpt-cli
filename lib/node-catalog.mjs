// 节点目录（node catalog）：本地节点构造器清单 + 线上节点类型清单的版本锚点与漂移检测
//
// 为什么需要：lib/nodes.mjs 的 20 个构造函数是「照某一版平台抄下来的」，
// 平台新增/改名节点后，CLI 不会自动知道——构造器里没有的节点只能手写原生 JSON，
// 字段变了则校验器仍按旧规则放行。和 ruleset.mjs 解决的是同一类问题：
//   本地知识是静态快照，平台会漂，必须让漂移可见。
//
// 两层来源（重要）：
//   · 本地清单：静态解析 lib/nodes.mjs 源码里的 flowNodeType/avatar/templateType
//     （声明式信息，不必执行构造器——有些构造器要必填参数，硬调会 throw）
//   · 线上清单：抓前端 chunk 里的 FlowNodeTypeEnum 枚举 + 节点模板 avatar
//
// 数据来源思路与 ruleset.mjs 一致：线上节点类型是从前端实际加载的 chunk 里提取的，
// 不是从 GitHub 源码抄的——因为「平台实际认哪些节点」以前端 bundle 为准。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

/** 我校准节点目录时，目标实例的版本 */
export const NODE_CATALOG_CALIBRATED_WITH = '4.17.3';

/**
 * 从本地 lib/nodes.mjs 静态解析出节点构造器清单。
 * 返回 [{ ctor, flowNodeType, avatar, templateType }]
 * 只读源码、不执行——避免必填参数构造器 throw。
 */
export function localNodeCatalog() {
  let src;
  try { src = readFileSync(join(__dir, 'nodes.mjs'), 'utf8'); }
  catch { return []; }

  // 先按构造器切块：`  xxx(id, {...}) {` 直到下一个同级 `  yyy(`
  const methodRe = /^  ([a-zA-Z][a-zA-Z0-9_]*)\(id,\s*\{/gm;
  const starts = [];
  let m;
  while ((m = methodRe.exec(src)) !== null) starts.push({ ctor: m[1], at: m.index });

  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const { ctor, at } = starts[i];
    if (ctor === 'raw') continue;   // raw 是透传，不产生固定节点类型
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    const block = src.slice(at, end);
    const ft = /flowNodeType:\s*'([A-Za-z0-9_]+)'/.exec(block);
    if (!ft) continue;
    const avatar = /avatar:\s*'([^']+)'/.exec(block);
    const template = /templateType:\s*'([^']+)'/.exec(block);
    out.push({
      ctor,
      flowNodeType: ft[1],
      avatar: avatar ? avatar[1] : null,      // null = 动态（如 pluginModule 由参数决定）
      templateType: template ? template[1] : null,
    });
  }
  return out;
}

/**
 * 与线上节点类型清单比对。
 * @param {object} p
 * @param {Array<string>} p.onlineTypes   线上 FlowNodeTypeEnum 的所有值（如 workflowStart/chatNode/...）
 * @param {Array<{ctor,flowNodeType,avatar,templateType}>} [p.local] 本地清单，缺省自动解析
 * @param {string} [p.targetVersion]      目标实例版本（用于对照锚点）
 * @returns 漂移报告
 */
export function compareNodeCatalog({ onlineTypes = [], local = null, targetVersion = null } = {}) {
  const localCat = local || localNodeCatalog();
  const localTypes = new Set(localCat.map(n => n.flowNodeType));
  const online = new Set(onlineTypes);

  // 线上有、本地构造器无 → 只能手写原生 JSON，CLI 帮不上忙（最该知道的）
  const missingLocal = [...online].filter(t => !localTypes.has(t)).sort();
  // 本地有、线上无 → 构造器可能已过期（平台删了节点 / 改名）
  const extraLocal = [...localTypes].filter(t => !online.has(t)).sort();

  const versionMatch = targetVersion === NODE_CATALOG_CALIBRATED_WITH;
  return {
    calibratedWith: NODE_CATALOG_CALIBRATED_WITH,
    targetVersion: targetVersion || 'unknown',
    versionMatch,
    localCount: localTypes.size,
    onlineCount: online.size,
    coveredCount: [...localTypes].filter(t => online.has(t)).length,
    // missingLocal 是重点：这些节点你只能用 node.raw() 手拼，且没有任何构造期保护
    missingLocal,
    extraLocal,
    verdict: missingLocal.length === 0 && extraLocal.length === 0 ? 'aligned' : 'drift',
    hint: missingLocal.length
      ? `线上有 ${missingLocal.length} 种节点本地没有构造器：${missingLocal.join(', ')}。这些只能用 node.raw() 手拼，建议按需补进 lib/nodes.mjs`
      : extraLocal.length
        ? `本地有 ${extraLocal.length} 种节点线上枚举里没见到：${extraLocal.join(', ')}。可能是平台改名/删除，或该版本未启用，建议核实`
        : '本地构造器覆盖与线上节点枚举一致',
  };
}

/** 重新校准的操作步骤（给人/agent 看，不自动改代码） */
export function calibrateNodeCatalog() {
  return {
    steps: [
      '1. 打开目标实例任意工作流编辑器（触发前端 chunk 加载）',
      '2. 用 CDP 抓 performance.getEntriesByType("resource") 里所有 .js URL（或运行 fastgpt wf nodes）',
      '3. 在 chunk 里 grep "FlowNodeTypeEnum\\." 得到该实例的节点类型全集；grep "core/workflow/template/" 得到 avatar 清单',
      '4. 对比本命令报出的 missingLocal，逐个决定是否在 lib/nodes.mjs 补构造器',
      '5. 更新 NODE_CATALOG_CALIBRATED_WITH 为目标实例 systemVersion',
    ],
    why: '节点类型和字段是平台行为的一部分，平台升级会漂；本地构造器表必须有版本锚点，否则会静默失准',
  };
}

/** 从一批 chunk 文本里提取线上节点类型清单（供 CDP 抓取后调用） */
export function extractOnlineNodeTypes(chunkTexts = []) {
  const types = new Set();
  const avatars = new Set();
  for (const t of chunkTexts) {
    // FlowNodeTypeEnum.xxx 引用
    for (const m of t.matchAll(/FlowNodeTypeEnum\.([A-Za-z][A-Za-z0-9_]*)/g)) types.add(m[1]);
    // builtin 映射表里 [n.FlowNodeTypeEnum.xxx]:"builtin:..." 已被上面覆盖
    // avatar 清单：core/workflow/template/xxx
    for (const m of t.matchAll(/core\/workflow\/template\/([A-Za-z0-9_]+)/g)) avatars.add(m[1]);
  }
  return { types: [...types].sort(), avatars: [...avatars].sort() };
}
