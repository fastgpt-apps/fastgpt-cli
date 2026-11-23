// DSL 快照：从「目标实例自己的前端 chunk」抽取节点模板与枚举，存成版本化快照，供自动升级。
//
// 数据来源（重要，只用目标实例自己的，绝不碰 GitHub 开源版——商业版与开源版节点/字段可能不同）：
//   · 内置节点模板：编辑器 bundle 里的对象字面量（{id:Enum.xxx, templateType, flowNodeType,
//     avatar, colorSchema, inputs, outputs}）。这是平台发给浏览器的配置，不是逆向算法。
//   · 枚举：bundle 里的 FlowNodeTypeEnum / WorkflowIOValueTypeEnum 等（((x={}).a="a",...) 形式）。
//
// 抽取方法（不是逆向，是「抽它自己发的配置」）：
//   1. 按内容特征定位模板对象（找 `FlowNodeTypeEnum.<member>` + `templateType:`）
//   2. 平衡括号切出完整对象字面量
//   3. 把 JS 字面量规整成可求值表达式（!0→true、Enum.member→"member"、i18n()→占位）
//   4. 用受限 new Function 求值（箭头函数字段会被安全丢弃/惰性，不影响数据字段）
//
// 局限（如实标注）：压缩代码的变量名会变，靠「内容特征」识别而非变量名；
// 平台大版本重构 bundle 时解析可能失效——所以快照带 pulledFrom 版本，失效可感知。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './account.mjs';

/** 已知节点模板的「内容特征」锚点：模板对象里出现这些字符串之一即可定位 */
const TEMPLATE_ANCHORS = [
  'FlowNodeTypeEnum.', 'templateType:', 'flowNodeType:', 'core/workflow/template/',
];

/** enum 成员识别用：某个 ((x={}).k="v",...) 块含这些锚点，判定它是哪个枚举 */
const ENUM_SIGNATURES = {
  flowNodeType: ['workflowStart', 'emptyNode', 'loopStart', 'ifElseNode'],
  ioValueType: ['arrayString', 'chatHistory', 'arrayAny', 'datasetQuote'],
  inputType: ['addInputParam', 'agentGenerated', 'selectLLMModel'],
  templateType: ['systemInput', 'toolCall', 'teamApp'],
};

/** 合法 IO valueType（服务端 zod 枚举，从快照里可刷新） */
export const DEFAULT_IO_VALUE_TYPES = [
  'string', 'number', 'boolean', 'object', 'arrayString', 'arrayNumber', 'arrayBoolean',
  'arrayObject', 'arrayAny', 'any', 'chatHistory', 'datasetQuote', 'dynamic',
  'selectDataset', 'selectApp',
];

/** 平衡括号：从 start 的 '{' 或 '[' 切出完整块 */
function sliceBalanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** 把压缩 JS 对象字面量规整成「可安全求值」的表达式文本 */
function normalizeJsLiteral(src) {
  let s = src;
  // 布尔简写
  s = s.replace(/!0(?![0-9])/g, 'true').replace(/!1(?![0-9])/g, 'false');
  // 枚举引用  xxx.SomeEnum.member → "member"
  s = s.replace(/[A-Za-z_$][\w$]*\.(?:[A-Za-z0-9_$]*Enum[A-Za-z0-9_$]*)\.([A-Za-z0-9_$]+)/g, '"$1"');
  // i18n 调用 → 字符串占位
  s = s.replace(/\(0,[A-Za-z_$][\w$]*\.i18nT\)\("([^"]+)"\)/g, '"i18n:$1"');
  return s;
}

/**
 * 从一段 chunk 文本里抽取所有内置节点模板（对象字面量）。
 * 返回 [{ flowNodeType, templateType, avatar, colorSchema, inputs, outputs, isTool }]
 */
export function extractNodeTemplates(chunkText) {
  const out = [];
  if (!chunkText || !chunkText.includes('FlowNodeTypeEnum.')) return out;

  // 以 `flowNodeType:xxx.Enum.member` 为锚，回退到最近的对象起点
  const anchorRe = /flowNodeType:\s*[A-Za-z_$][\w$]*\.[\w$]*Enum\.[A-Za-z0-9_$]+/g;
  let m;
  const seenTypes = new Set();
  while ((m = anchorRe.exec(chunkText)) !== null) {
    // 回退到包含它的对象字面量起点：从锚点往前找 `{id:`
    const before = chunkText.lastIndexOf('{id:', m.index);
    if (before < 0 || m.index - before > 1200) continue;
    const block = sliceBalanced(chunkText, before);
    if (!block) continue;
    const norm = normalizeJsLiteral(block);
    // 受限求值：包一层，只取数据字段。箭头函数字段会被求值成 function，JSON 序列化时自然丢弃。
    let val;
    try {
      // eslint-disable-next-line no-new-func
      val = new Function(`return (${norm});`)();
    } catch { continue; }
    if (!val || typeof val !== 'object' || !val.flowNodeType) continue;
    // i18n 占位还原：name 可能是 "i18n:workflow:xxx"
    const ft = String(val.flowNodeType);
    if (seenTypes.has(ft)) continue;   // 同类节点只取第一次（模板里可能重复定义 avatar 变体）
    seenTypes.add(ft);
    out.push({
      flowNodeType: ft,
      templateType: val.templateType || null,
      avatar: typeof val.avatar === 'string' ? val.avatar : null,
      colorSchema: val.colorSchema || null,
      isTool: val.isTool === true,
      inputs: Array.isArray(val.inputs) ? val.inputs : [],
      outputs: Array.isArray(val.outputs) ? val.outputs : [],
    });
  }
  return out;
}

/**
 * 从 chunk 文本里抽取 `((x={}).a="a",...)` 形式的枚举。
 * 返回 { flowNodeType: [...], ioValueType: [...], inputType: [...], templateType: [...] }（按内容特征识别）
 */
export function extractEnums(chunkText) {
  const groups = [];
  // 匹配 =((VAR={}) 起点
  const startRe = /=\(\(([A-Za-z_$][\w$]*)=\{\}\)/g;
  let m;
  while ((m = startRe.exec(chunkText)) !== null) {
    const varName = m[1];
    let pos = m.index + m[0].length;
    const members = [];
    // 连续吃 .key="val", 或  VAR.key="val",
    const pairRe = new RegExp(`^(?:${varName.replace(/\$/g, '\\$')}\\.|\\.)([A-Za-z0-9_$]+)="([^"]*)"[,]?`);
    while (true) {
      const rest = chunkText.slice(pos, pos + 200);
      const mm = pairRe.exec(rest);
      if (!mm) break;
      members.push({ k: mm[1], v: mm[2] });
      pos += mm[0].length;
    }
    if (members.length >= 2) groups.push(members.map(x => x.v));
  }

  const pick = (sig) => {
    for (const g of groups) {
      const set = new Set(g);
      if (sig.every(s => set.has(s))) return g;
    }
    return null;
  };
  return {
    flowNodeType: pick(ENUM_SIGNATURES.flowNodeType) || [],
    ioValueType: pick(ENUM_SIGNATURES.ioValueType) || [],
    inputType: pick(ENUM_SIGNATURES.inputType) || [],
    templateType: pick(ENUM_SIGNATURES.templateType) || [],
  };
}

/**
 * 从一批 chunk 文本构建完整 DSL 快照。
 * @param {Array<{url:string, body:string}>} chunks
 * @param {{instanceVersion?:string, base?:string}} meta
 */
export function buildSnapshot(chunks = [], meta = {}) {
  const nodeTemplates = new Map();
  const enums = { flowNodeType: [], ioValueType: [], inputType: [], templateType: [] };
  const parsedChunks = new Set();

  for (const c of chunks) {
    const body = c.body || '';
    // 枚举可能在独立 chunk（不包含 FlowNodeTypeEnum. 字样），所以先无条件抽枚举
    const e = extractEnums(body);
    if (e.flowNodeType.length || e.ioValueType.length || e.inputType.length || e.templateType.length) {
      for (const k of Object.keys(enums)) {
        for (const v of e[k]) if (!enums[k].includes(v)) enums[k].push(v);
      }
      parsedChunks.add(c.url);
    }
    // 节点模板只存在于含 FlowNodeTypeEnum. 的 chunk
    if (!body.includes('FlowNodeTypeEnum.')) continue;
    for (const tpl of extractNodeTemplates(body)) {
      if (!nodeTemplates.has(tpl.flowNodeType)) nodeTemplates.set(tpl.flowNodeType, tpl);
    }
    parsedChunks.add(c.url);
  }

  return {
    schema: 1,
    pulledFrom: meta.instanceVersion || 'unknown',
    base: meta.base || null,
    pulledAt: new Date().toISOString(),
    parsedChunkCount: parsedChunks.size,
    nodes: [...nodeTemplates.values()].sort((a, b) => a.flowNodeType.localeCompare(b.flowNodeType)),
    enums,
  };
}

/**
 * 对比两个快照，报漂移：
 *   addedNodes / removedNodes / changedNodes（avatar/templateType/inputs 字段变化）
 *   addedEnumValues / removedEnumValues
 */
export function diffSnapshot(prev, next) {
  const p = prev?.nodes || [];
  const n = next?.nodes || [];
  const pMap = new Map(p.map(x => [x.flowNodeType, x]));
  const nMap = new Map(n.map(x => [x.flowNodeType, x]));

  const addedNodes = n.filter(x => !pMap.has(x.flowNodeType)).map(x => x.flowNodeType);
  const removedNodes = p.filter(x => !nMap.has(x.flowNodeType)).map(x => x.flowNodeType);
  const changedNodes = [];
  for (const [ft, nn] of nMap) {
    const pn = pMap.get(ft);
    if (!pn) continue;
    const changes = [];
    if (pn.avatar !== nn.avatar) changes.push('avatar');
    if (pn.templateType !== nn.templateType) changes.push('templateType');
    // inputs：比较 key 集合（新增/删除字段最值得关注）
    const pKeys = new Set((pn.inputs || []).map(i => i.key).filter(Boolean));
    const nKeys = new Set((nn.inputs || []).map(i => i.key).filter(Boolean));
    const addedInputs = [...nKeys].filter(k => !pKeys.has(k));
    const removedInputs = [...pKeys].filter(k => !nKeys.has(k));
    if (addedInputs.length) changes.push(`+inputs:${addedInputs.join(',')}`);
    if (removedInputs.length) changes.push(`-inputs:${removedInputs.join(',')}`);
    if (changes.length) changedNodes.push({ flowNodeType: ft, changes });
  }

  const enumDrift = {};
  for (const k of ['flowNodeType', 'ioValueType', 'inputType', 'templateType']) {
    const pv = new Set(prev?.enums?.[k] || []);
    const nv = new Set(next?.enums?.[k] || []);
    const added = [...nv].filter(x => !pv.has(x));
    const removed = [...pv].filter(x => !nv.has(x));
    if (added.length || removed.length) enumDrift[k] = { added, removed };
  }

  return {
    nodeCount: { prev: p.length, next: n.length },
    addedNodes, removedNodes, changedNodes,
    enumDrift,
    drifted: addedNodes.length + removedNodes.length + changedNodes.length + Object.keys(enumDrift).length > 0,
  };
}

/** 从快照文件读快照（路径缺省 <HOME>/dsl-snapshot.json，HOME 随账号） */
export function loadSnapshot(filePath) {
  const p = filePath || join(HOME, 'dsl-snapshot.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 从 DSL 快照的节点模板，通用构造一个节点（node.fromType 的实现）。
 * 用途：构造快照里有、但 nodes.mjs 没写构造器的节点（如 toolParams/formInput/userSelect）。
 * 自动修常见陷阱：引用型输入补 selectedType:reference。
 *
 * @param {object} snapshot   loadSnapshot() 的返回，或 buildSnapshot() 的结果
 * @param {string} flowNodeType  节点类型（如 'toolParams'）
 * @param {string} id  节点 id
 * @param {object} [overrides]  覆盖字段：{ inputs, outputs, name, x, y, ... }；
 *   inputs 支持「按 key 合并」：传 [{key:'xx', value:...}] 只覆盖对应 input 的 value
 * @returns 节点对象
 */
export function buildNodeFromTemplate(snapshot, flowNodeType, id, overrides = {}) {
  const tpl = (snapshot?.nodes || []).find(n => n.flowNodeType === flowNodeType);
  if (!tpl) {
    const known = (snapshot?.nodes || []).map(n => n.flowNodeType);
    const hint = known.length
      ? `可用类型：${known.join(', ')}`
      : '快照为空，先跑 fastgpt dsl pull';
    throw new Error(`快照里没有节点类型 "${flowNodeType}"。${hint}`);
  }

  // 深拷贝模板 inputs，避免污染快照
  const inputs = (tpl.inputs || []).map(i => {
    const copy = JSON.parse(JSON.stringify(i));
    // 引用型输入自动补 selectedType/renderTypeList
    const isRef = Array.isArray(copy.value) && copy.value.length === 2 && typeof copy.value[0] === 'string';
    if (isRef) {
      if (copy.selectedType !== 'reference') copy.selectedType = 'reference';
      if (Array.isArray(copy.renderTypeList) && !copy.renderTypeList.includes('reference')) copy.renderTypeList.push('reference');
    }
    return copy;
  });
  const outputs = (tpl.outputs || []).map(o => JSON.parse(JSON.stringify(o)));

  const node = {
    nodeId: id,
    flowNodeType,
    name: overrides.name || flowNodeType,
    avatar: tpl.avatar || undefined,
    templateType: tpl.templateType || undefined,
    colorSchema: tpl.colorSchema || undefined,
    isTool: tpl.isTool || undefined,
    showSourceHandle: true,
    showTargetHandle: true,
    position: { x: overrides.x ?? 0, y: overrides.y ?? 0 },
    inputs,
    outputs,
  };

  // 应用 overrides：inputs 按 key 合并（只覆盖值），其他字段直接覆盖
  if (Array.isArray(overrides.inputs)) {
    for (const ov of overrides.inputs) {
      if (!ov || !ov.key) continue;
      const target = node.inputs.find(i => i.key === ov.key);
      if (target) Object.assign(target, ov);
      else node.inputs.push(ov);   // 模板里没有的，追加
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (['inputs', 'x', 'y', 'name'].includes(k)) continue;
    node[k] = v;
  }
  return node;
}
