// 连线构造器 + 校验器 + 规范化器
//
// handle 规则（源码 getHandleId(nodeId, type, key) => `${nodeId}-${type}-${key}`）：
//   普通输出： `${nodeId}-source-right`
//   分支输出： `${nodeId}-source-${branchKey}`   ← 顺序是 type 在前（ifElse 用 branchId，ELSE 是内建分支）
//   异常输出： `${nodeId}-source_catch-right`
//   普通输入： `${nodeId}-target-left`
//
// 校验分三层（对应线上实测过的三类坑）：
//   A. 图结构：节点 ID、连线、handle 形态、孤立节点
//   B. 输入语义：引用可解析（含全局变量）、selectedType、字段名、值类型
//   C. 前端渲染：裸变量占位、canEdit 常量、addInputParam null —— 这三类 JSON 看着对，
//      但前端会显示成「选择引用变量」空占位 / 报「存在未完成的输入变量配置」

/** 全局变量在引用里的伪节点 ID（FastGPT 官方机制，不是普通节点） */
export const VARIABLE_NODE_ID = 'VARIABLE_NODE_ID';

/** 拿不到已有节点时补的那条边（source/target 全连或者用于快速试跑） */
export function edge(source, target, fromKey = 'right') {
  if (!source || !target) throw new Error('edge 需要 source 和 target');
  if (typeof fromKey !== 'string' || !fromKey) throw new Error('fromKey 非法');
  return {
    source,
    sourceHandle: `${source}-source-${fromKey}`,
    target,
    targetHandle: `${target}-target-left`
  };
}

/** 从最左节点开始自动串成一条链 */
export function chain(nodeIds) {
  const out = [];
  for (let i = 0; i < nodeIds.length - 1; i++) out.push(edge(nodeIds[i], nodeIds[i + 1]));
  return out;
}

const isRef = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string';

/** 把代码按「代码段 / 字符串·注释段」切分，只在代码段里做标识符替换 */
function replaceIdentifier(code, key, literal) {
  const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b[A-Za-z_$][\w$]*\b)/g;
  let hits = 0;
  const out = code.replace(re, (m, skip, ident) => {
    if (skip) return m;
    if (ident === key) { hits += 1; return literal; }
    return m;
  });
  return { out, hits };
}

/** 去掉注释与字符串后，标识符是否还残留（用于确认内联是否彻底） */
function hasIdentifier(code, key) {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
  return new RegExp(`\\b${key}\\b`).test(stripped);
}

/**
 * 常量内联：code 节点里 canEdit 的动态输入只认引用，常量值会被前端渲染成空占位。
 * 安全前提：代码里确实把该 key 当变量用；替换后若仍有残留就整体放弃，不做半成品。
 * 触发条件苛刻（默认关闭），因为这是内容级修改。
 */
function tryInlineConstInputs(node, key, value) {
  const codeInp = (node.inputs || []).find(i => i.key === 'code');
  if (!codeInp || typeof codeInp.value !== 'string') return null;
  const literal = JSON.stringify(value);
  let code = codeInp.value;

  // 从 main 解构参数里剔除
  code = code.replace(/async function main\(\{([\s\S]*?)\}\)/, (m, args) => {
    const kept = args.split(',').map(x => x.trim()).filter(Boolean).filter(a => a !== key);
    return `async function main({ ${kept.join(', ')} })`;
  });

  const { out, hits } = replaceIdentifier(code, key, literal);
  if (hits === 0) return null;            // 代码里没用到，不做
  if (hasIdentifier(out, key)) return null; // 有残留（模板串/动态属性等），放弃
  return { code: out, hits };
}



/** 分支节点的可选分支 key（ifElse 的 ELSE 是内建兜底分支，不在 ifElseList 里） */
export function branchKeys(node) {
  if (!node) return new Set();
  if (node.flowNodeType === 'ifElseNode') {
    const list = (node.inputs || []).find(i => i.key === 'ifElseList')?.value || [];
    const keys = new Set(list.map(b => b.branchId).filter(Boolean));
    keys.add('ELSE');
    return keys;
  }
  if (node.flowNodeType === 'classifyQuestion') {
    const agents = (node.inputs || []).find(i => i.key === 'agents')?.value || [];
    return new Set(agents.map(a => a.key));
  }
  return new Set();
}

const BRANCH_NODE_TYPES = new Set(['ifElseNode', 'classifyQuestion']);

/**
 * 官方 FlowNodeInputTypeEnum（4.17.3 的 zod 枚举，实测抄下来）。
 * selectedType 落在集合外会直接被服务端 zod 拒（Data validation error），
 * 而且报错只说「Invalid option」，不告诉你是哪个节点 —— 所以必须在本地拦。
 * 注意：没有 'codeEditor'，代码输入要用 'custom'。
 */
export const INPUT_RENDER_TYPES = new Set([
  'reference', 'input', 'textarea', 'numberInput', 'switch', 'select', 'multipleSelect',
  'JSONEditor', 'addInputParam', 'customVariable', 'selectApp', 'selectLLMModel',
  'settingLLMModel', 'selectDataset', 'selectDatasetParamsModal', 'settingDatasetQuotePrompt',
  'hidden', 'custom', 'selectSkill', 'selectTool', 'fileSelect', 'timePointSelect',
  'timeRangeSelect', 'password', 'datasetTagFilter', 'off', 'agentGenerated'
]);

/**
 * 规范化：把「能跑但前端不认」的写法修成官方形态。
 * 返回 { nodes, edges, fixes }，不改入参，供 `wf lint --fix` 与 `wf build` 前置使用。
 */
export function normalizeWorkflow({ nodes = [], edges = [], chatConfig = {}, inlineConstInputs = false }) {
  const fixes = [];
  const outNodes = structuredClone(nodes);
  const outEdges = structuredClone(edges);
  const byId = new Map(outNodes.map(n => [n.nodeId, n]));
  const varKeys = new Set((chatConfig.variables || []).map(v => v.key));

  // 0) 坐标：简写 DSL 里写 x/y 会被当成未知字段，服务端 zod 拒绝后【整节点丢弃】。
  //    实测 37 节点丢成 29（正好是带 x/y 的那批）。统一搬进 position。
  for (const n of outNodes) {
    if (n.x !== undefined || n.y !== undefined) {
      const px = n.position?.x ?? n.x ?? 0;
      const py = n.position?.y ?? n.y ?? 0;
      if (n.position?.x !== px || n.position?.y !== py) {
        fixes.push({ where: `${n.nodeId}.position`, from: JSON.stringify(n.position ?? null),
                     to: JSON.stringify({ x: px, y: py }),
                     reason: 'x/y 是未知字段，会让服务端丢弃整个节点' });
        n.position = { x: px, y: py };
      }
      delete n.x; delete n.y;
    }
  }

  // 1) handle 形态
  for (const e of outEdges) {
    // 工具挂载边是固定语义（selectedTools ↔ selectedTools），不能按普通连线改写
    if (e.sourceHandle === 'selectedTools' || e.targetHandle === 'selectedTools') continue;
    const src = byId.get(e.source);
    const m = /-source(?:_catch)?-(.+)$/.exec(e.sourceHandle || '');
    const key = m?.[1];
    const isCatch = /-source_catch-/.test(e.sourceHandle || '');
    let want;
    if (isCatch) want = `${e.source}-source_catch-right`;
    else if (src && BRANCH_NODE_TYPES.has(src.flowNodeType)) {
      want = key ? `${e.source}-source-${key}` : `${e.source}-source-right`;
    } else want = `${e.source}-source-right`;
    if (e.sourceHandle !== want) {
      fixes.push({ where: `edge ${e.source}->${e.target}`, from: e.sourceHandle, to: want, reason: 'handle 形态过旧（本实例普通输出固定 -source-right）' });
      e.sourceHandle = want;
    }
    const wantT = `${e.target}-target-left`;
    if (e.targetHandle !== wantT) {
      fixes.push({ where: `edge ${e.source}->${e.target}`, from: e.targetHandle, to: wantT, reason: 'targetHandle 固定 -target-left' });
      e.targetHandle = wantT;
    }
  }

  // 1.3) 引用型输入的 valueType 必须与引用源输出【精确一致】
  //      服务端 zod 会把不匹配的值直接 strip 成 null，画布报「存在未完成的输入变量配置」。
  //      典型：results 引用 parallelSuccessResults(arrayAny) 却声明成 any → value 变 null。
  {
    const outType = new Map();     // "nodeId.outputKey" -> valueType
    for (const n of outNodes) {
      for (const o of n.outputs || []) outType.set(`${n.nodeId}.${o.key}`, o.valueType || 'string');
    }
    for (const n of outNodes) {
      for (const inp of n.inputs || []) {
        if (!Array.isArray(inp.value) || inp.value.length !== 2) continue;
        const [src, key] = inp.value;
        if (src === 'VARIABLE_NODE_ID') {
          // 按变量自己声明的 valueType 对齐。
          // 以前一律写死 string，会把 readFiles 的 fileUrlList（arrayString）降级，
          // 变量声明成 arrayString 时引用它的输入也必须是 arrayString。
          const vd = (chatConfig.variables || []).find(v => v.key === key);
          const want = vd?.valueType || 'string';
          if (inp.valueType !== want) {
            fixes.push({ where: `${n.nodeId}.${inp.key}.valueType`, from: String(inp.valueType), to: want,
                         reason: `引用变量 ${key}（${want}），类型不符会被服务端 strip 成 null/[]` });
            inp.valueType = want;
          }
          continue;
        }
        const want = outType.get(`${src}.${key}`);
        if (want && inp.valueType !== want) {
          fixes.push({
            where: `${n.nodeId}.${inp.key}.valueType`, from: String(inp.valueType), to: want,
            reason: `引用 ${src}.${key}（${want}），类型不符会被服务端 zod strip 成 null`
          });
          inp.valueType = want;
        }
      }
    }
  }

  // 1.5) 并行容器作用域 —— FastGPT 用 childrenNodeIdList 声明"谁在我肚子里"，
  //      子节点自身还必须带 parentNodeId，loopEnd 还要用 loopEndInput 指向上游输出。
  //      这三处缺任何一个，画布会报：
  //        「节点 X 与 Y 不在同一流程作用域，不能直接连线」
  //        「未与其他节点连线」
  //        「需填写必填项 loopEndInput」
  {
    const usedLoopStarts = new Set();   // 多个 parallelRun 时按出现顺序配对 loopStart
    const adj = new Map();
    for (const e of outEdges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
    for (const par of outNodes) {
      if (par.flowNodeType !== 'parallelRun') continue;
      const listInput = (par.inputs || []).find(i => i.key === 'childrenNodeIdList');
      if (!listInput) continue;

      const declared = Array.isArray(listInput.value) ? [...listInput.value] : [];
      // childrenNodeIdList 可能是空数组（构造函数默认留空，交给这里补），
      // 所以不能只靠 declared[0]。退而求其次：找一个还没被其它容器占用的 loopStart。
      let startId = declared[0];
      if (!startId) {
        const cand = outNodes.find(n => n.flowNodeType === 'loopStart' && !usedLoopStarts.has(n.nodeId));
        startId = cand?.nodeId;
      }
      if (!startId || byId.get(startId)?.flowNodeType !== 'loopStart') continue;
      usedLoopStarts.add(startId);

      // 从 loopStart 沿边走到 loopEnd，中间经过的就是循环体
      const chain = [startId];
      let cur = startId;
      for (let guard = 0; guard < 50; guard++) {
        const next = (adj.get(cur) || []).find(t => byId.has(t) && !chain.includes(t));
        if (!next) break;
        chain.push(next);
        cur = next;
        if (byId.get(next)?.flowNodeType === 'loopEnd') break;
      }
      // 补全 childrenNodeIdList
      if (JSON.stringify(listInput.value) !== JSON.stringify(chain)) {
        fixes.push({
          where: `${par.nodeId}.childrenNodeIdList`,
          from: `[${declared.join(', ')}]`, to: `[${chain.join(', ')}]`,
          reason: '循环体节点缺失，画布会判定「不在同一流程作用域」'
        });
        listInput.value = chain;
      }
      // 给每个子节点补 parentNodeId
      for (const cid of chain) {
        const child = byId.get(cid);
        if (!child) continue;
        if (child.parentNodeId !== par.nodeId) {
          fixes.push({
            where: `${cid}.parentNodeId`, from: child.parentNodeId ?? 'null', to: par.nodeId,
            reason: '子节点缺作用域归属，画布会判「不在同一流程作用域」'
          });
          child.parentNodeId = par.nodeId;
        }
      }
      // loopEnd 的输出引用
      const endNode = byId.get(chain[chain.length - 1]);
      const srcNode = byId.get(chain[chain.length - 2]);
      if (endNode?.flowNodeType === 'loopEnd' && srcNode) {
        const inp = (endNode.inputs || []).find(i => i.key === 'loopEndInput');
        if (inp && (!Array.isArray(inp.value) || inp.value.length !== 2)) {
          const out = (srcNode.outputs || []).find(o => !String(o.key).startsWith('system_') && o.key !== 'error')
                   || (srcNode.outputs || [])[0];
          if (out) {
            fixes.push({
              where: `${endNode.nodeId}.loopEndInput`, from: JSON.stringify(inp.value ?? null),
              to: `["${srcNode.nodeId}", "${out.key}"]`,
              reason: '循环结果没有接入点，画布报「需填写必填项 loopEndInput」'
            });
            inp.value = [srcNode.nodeId, out.key];
          }
        }
      }
    }
  }

  // 2) 输入层
  for (const n of outNodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'system_addInputParam' && inp.value == null) {
        inp.value = [];
        fixes.push({ where: `${n.nodeId}.system_addInputParam`, from: 'null', to: '[]', reason: '动态输入表格按数组处理' });
      }
      // 裸变量占位 -> 官方引用语法
      const fixStr = s =>
        s.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, key) => {
          if (!varKeys.has(key)) return m;
          fixes.push({ where: `${n.nodeId}.${inp.key}`, from: m, to: `{{$VARIABLE_NODE_ID.${key}$}}`, reason: '裸变量前端不渲染成引用' });
          return `{{$VARIABLE_NODE_ID.${key}$}}`;
        });
      if (typeof inp.value === 'string') inp.value = fixStr(inp.value);
      else if (inp.value && typeof inp.value === 'object') {
        const walk = obj => {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') obj[k] = fixStr(v);
            else if (v && typeof v === 'object') walk(v);
          }
        };
        walk(inp.value);
      }
    }
    // canEdit 常量：可选内联进代码后删除输入项
    if (inlineConstInputs && n.flowNodeType === 'code') {
      for (const inp of [...(n.inputs || [])]) {
        if (inp.canEdit !== true) continue;
        if (isRef(inp.value)) continue;
        const inlined = tryInlineConstInputs(n, inp.key, inp.value);
        if (!inlined) continue;
        const codeInp = n.inputs.find(i => i.key === 'code');
        codeInp.value = inlined.code;
        n.inputs = n.inputs.filter(i => i !== inp);
        fixes.push({
          where: `${n.nodeId}.${inp.key}`,
          from: `canEdit 常量 ${JSON.stringify(inp.value)}（${inlined.hits} 处引用）`,
          to: '内联进代码并删除该输入项',
          reason: '动态输入只认引用，常量会被前端渲染成空占位并报「存在未完成的输入变量配置」'
        });
      }
    }

    // ifElse 条件值必须是 string 或引用
    if (n.flowNodeType === 'ifElseNode') {
      const list = (n.inputs || []).find(i => i.key === 'ifElseList')?.value || [];
      for (const branch of list) {
        for (const item of branch.list || []) {
          if (typeof item.value === 'number' || typeof item.value === 'boolean') {
            fixes.push({ where: `${n.nodeId}.ifElseList`, from: JSON.stringify(item.value), to: `"${item.value}"`, reason: 'schema 只收 string | [nodeId, outputKey]' });
            item.value = String(item.value);
          }
          if (item.valueType && !['input', 'reference'].includes(item.valueType)) {
            fixes.push({ where: `${n.nodeId}.ifElseList`, from: item.valueType, to: 'input', reason: 'valueType 只能是 input | reference' });
            item.valueType = 'input';
          }
        }
      }
    }
  }

  return { nodes: outNodes, edges: outEdges, fixes };
}

/**
 * 保存前硬校验。返回 {ok, errors, warnings}
 * 目标：把 UI 上才会暴露的问题提前到 CLI 阶段
 */
export function validateWorkflow({ nodes = [], edges = [], chatConfig = {} }) {
  const errors = [];
  const warnings = [];
  // 结构化诊断：errors 是给人/测试看的字符串，issues 是给 agent 看的可执行条目。
  // fix: 'auto' = wf lint --fix 能修掉；'manual' = 必须人/agent 改内容。
  const issues = [];
  const err = (code, message, extra = {}) => {
    errors.push(message);
    issues.push({ code, message, fix: extra.fix || 'manual', ...extra });
  };
  const byId = new Map();
  const varKeys = new Set((chatConfig.variables || []).map(v => v.key));

  // 1. 节点 ID 唯一
  for (const n of nodes) {
    if (!n.nodeId) { errors.push('存在缺少 nodeId 的节点'); continue; }
    if (byId.has(n.nodeId)) errors.push(`nodeId 重复: ${n.nodeId}`);
    byId.set(n.nodeId, n);
  }

  // 1.9) 死代码检测（自优化）—— 复杂图里最容易堆积的两类垃圾
  //      不报错、不影响运行，但会让画布杂乱、变量越传越多、payload 白白变大。
  {
    const allText = JSON.stringify(nodes);
    // ① 变量：0 引用的（{{$VARIABLE_NODE_ID.x$}} 或 ["VARIABLE_NODE_ID","x"] 都算）
    for (const v of chatConfig.variables || []) {
      const k = v.key;
      const used =
        new RegExp(`\\{\\{\\$VARIABLE_NODE_ID\\.${k}\\$\\}\\}`).test(allText) ||
        allText.includes(`"VARIABLE_NODE_ID","${k}"`) ||
        allText.includes(`"VARIABLE_NODE_ID", "${k}"`);
      if (!used) {
        warnings.push(`变量「${k}」没有任何节点引用 —— FastGPT 会静默丢弃它，建议删掉（或者在节点里真正用起来）`);
      }
    }
    // ② 节点：无入边且不是起点/容器内 loopStart
    const hasIn = new Set((edges || []).map(e => e.target));
    const containerChildren = new Set();
    for (const n of nodes) {
      if (n.flowNodeType !== 'parallelRun') continue;
      for (const i of n.inputs || []) {
        if (i.key === 'childrenNodeIdList' && Array.isArray(i.value)) i.value.forEach(c => containerChildren.add(c));
      }
    }
    for (const n of nodes) {
      if (hasIn.has(n.nodeId)) continue;
      if (n.flowNodeType === 'workflowStart' || n.flowNodeType === 'pluginInput') continue;
      if (n.flowNodeType === 'loopStart' || containerChildren.has(n.nodeId)) continue;
      warnings.push(`节点 ${n.nodeId}（${n.flowNodeType}）没有任何入边，是孤立节点 —— 运行到不了，建议删除`);
    }
    // ③ code 节点声明了 dynInput 但代码里没用
    for (const n of nodes) {
      if (n.flowNodeType !== 'code') continue;
      const code = (n.inputs || []).find(i => i.key === 'code')?.value || '';
      for (const inp of n.inputs || []) {
        if (['system_addInputParam', 'codeType', 'code'].includes(inp.key)) continue;
        if (!inp.key) continue;
        const re = new RegExp(`\\b${inp.key}\\b`);
        if (!re.test(code)) {
          warnings.push(`${n.nodeId} 的输入「${inp.key}」在代码里没有被用到 —— 白占一个引用，建议删掉`);
        }
      }
    }
  }

  // 2. 必须有开始节点：工作流要 workflowStart；工具（plugin）用 pluginInput 当起点，不需要 workflowStart
  const starts = nodes.filter(n => n.flowNodeType === 'workflowStart');
  const pluginStarts = nodes.filter(n => n.flowNodeType === 'pluginInput');
  if (starts.length === 0 && pluginStarts.length === 0) {
    errors.push('缺少 workflowStart 节点（工具应用应改用 pluginInput 作起点）');
  }
  if (starts.length > 1) errors.push('workflowStart 只能有一个');
  if (pluginStarts.length > 1) errors.push('pluginInput 只能有一个');
  if (starts.length && pluginStarts.length) errors.push('workflowStart 与 pluginInput 不能共存（工作流应用 vs 工具应用）');

  // 3. 边完整性 + handle 格式
  const outputIds = new Map();
  const outputTypes = new Map();   // "nodeId.outputKey" -> valueType，供引用类型一致性检查用
  for (const n of nodes) {
    outputIds.set(n.nodeId, new Set((n.outputs || []).map(o => o.id)));
    for (const o of n.outputs || []) {
      if (o.valueType) outputTypes.set(`${n.nodeId}.${o.id}`, o.valueType);
    }
  }
  for (const [i, e] of edges.entries()) {
    if (!byId.has(e.source)) errors.push(`edge[${i}] source 不存在: ${e.source}`);
    if (!byId.has(e.target)) errors.push(`edge[${i}] target 不存在: ${e.target}`);

    // 工具挂载专用连线：tools --[selectedTools]--> pluginModule/toolSet
    if (e.sourceHandle === 'selectedTools' && e.targetHandle === 'selectedTools') {
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      if (src && src.flowNodeType !== 'tools' && src.flowNodeType !== 'agent') {
        errors.push(`edge[${i}] 用 selectedTools 连线，但 source(${e.source}) 不是 tools/agent 节点`);
      }
      if (tgt && !['pluginModule', 'toolSet', 'tool', 'plugin'].includes(tgt.flowNodeType)) {
        errors.push(`edge[${i}] 用 selectedTools 连线，但 target(${e.target}) 不是工具节点`);
      }
      continue;  // 跳过普通 handle 格式校验
    }

    const src = byId.get(e.source);
    if (src) {
      if (BRANCH_NODE_TYPES.has(src.flowNodeType)) {
        const keys = branchKeys(src);
        const m = /-source-(.+)$/.exec(e.sourceHandle || '');
        const key = m?.[1];
        if (!key) err('handle_format', `edge[${i}] sourceHandle 格式错误: ${e.sourceHandle}（应为 ${e.source}-source-<branchKey>）`, { fix: 'auto' });
        else if (key !== 'right' && !keys.has(key)) err('handle_branch', `edge[${i}] 分支 key "${key}" 不在分支列表，可用: ${[...keys].join(', ')}`, { fix: 'manual' });
      } else {
        const expect = `${e.source}-source-right`;
        const isCatchHandle = e.sourceHandle === `${e.source}-source_catch-right`;
        if (e.sourceHandle !== expect && !isCatchHandle) {
          err('handle_legacy_port', `edge[${i}] sourceHandle 应为 "${expect}"，实际 "${e.sourceHandle}"（旧版按输出 key 命名；wf lint --fix 可自动修）`, { fix: 'auto', where: `${e.source}->${e.target}` });
        }
      }
    }
    const expectT = `${e.target}-target-left`;
    if (e.targetHandle !== expectT) err('handle_target', `edge[${i}] targetHandle 应为 "${expectT}"，实际 "${e.targetHandle}"`, { fix: 'auto', where: `${e.source}->${e.target}` });
  }

  // 4. 引用必须可解析 + selectedType 必须为 reference
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      const v = inp.value;
      if (isRef(v)) {
        const [nid, oid] = v;
        if (nid === VARIABLE_NODE_ID) {
          // 全局变量是官方机制，不是节点引用；只校验 key 是否定义过
          if (!varKeys.has(oid)) {
            err('var_undefined', `${n.nodeId}.${inp.key} 引用了未定义的全局变量 ${oid}（chatConfig.variables 里没有这个 key）`, { where: `${n.nodeId}.${inp.key}`, variable: oid });
          }
        } else if (!byId.has(nid)) {
          err('ref_node', `${n.nodeId}.${inp.key} 引用了不存在的节点 ${nid}`, { where: `${n.nodeId}.${inp.key}`, nodeId: nid });
        } else if (!outputIds.get(nid).has(oid)) {
          err('ref_output', `${n.nodeId}.${inp.key} 引用了 ${nid} 上不存在的输出 ${oid}，可用: ${[...outputIds.get(nid)].join(', ')}`, { where: `${n.nodeId}.${inp.key}` });
        }
        if (inp.selectedType !== 'reference') {
          err('ref_selected_type', `${n.nodeId}.${inp.key} 是引用但 selectedType="${inp.selectedType}"，UI 不会渲染成变量（必须为 reference）`, { fix: 'auto', where: `${n.nodeId}.${inp.key}` });
        }
        // 引用类型一致性：输入声明的 valueType 必须与引用源输出类型一致，
        // 否则服务端 zod 会把值 strip 成 null/[]，画布显示「存在未完成的输入变量配置」。
        // normalizeWorkflow 会主动对齐，但 validate 必须能独立报出——否则绕过 normalize
        // 的路径（如 wf diffcheck、外部直接校验）会漏判。这里只在两边都明确且冲突时报。
        if (nid !== VARIABLE_NODE_ID && byId.has(nid) && outputIds.get(nid).has(oid)) {
          const want = outputTypes.get(`${nid}.${oid}`);
          if (want && inp.valueType && inp.valueType !== want && inp.valueType !== 'any') {
            err('ref_type_mismatch',
              `${n.nodeId}.${inp.key} 的 valueType="${inp.valueType}"，但引用的 ${nid}.${oid} 是 "${want}"——类型不符会被服务端 strip 成 null/[]，画布报「存在未完成的输入变量配置」（wf lint --fix 会自动对齐）`,
              { fix: 'auto', where: `${n.nodeId}.${inp.key}`, from: inp.valueType, to: want });
          }
        }
      }
    }
  }

  // 5. modelId 格式
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'modelId' && typeof inp.value === 'string' && inp.value && !/^[0-9a-f]{24}$/i.test(inp.value)) {
        warnings.push(`${n.nodeId}.modelId="${inp.value}" 不是 24 位 ObjectId，发布可能报 "Model model is unavailable"`);
      }
    }
  }

  // 6. 多个 answerNode 引用同一输出（可能导致重复回复）
  const refMap = new Map();
  for (const n of nodes) {
    if (n.flowNodeType !== 'answerNode') continue;
    for (const inp of n.inputs || []) {
      if (Array.isArray(inp.value) && inp.value.length === 2 && typeof inp.value[0] === 'string') {
        const k = `${inp.value[0]}:${inp.value[1]}`;
        if (!refMap.has(k)) refMap.set(k, []);
        refMap.get(k).push(n.nodeId);
      }
    }
  }
  for (const [k, answerIds] of refMap) {
    if (answerIds.length <= 1) continue;
    const reach = checkMutuallyExclusive(answerIds, nodes, edges);
    if (reach.exclusive) {
      warnings.push(`多个 answerNode 引用同一输出 ${k}（${answerIds.join(', ')}），但它们分属互斥分支，可忽略`);
    } else {
      errors.push(
        `多个 answerNode 引用同一输出 ${k}（${answerIds.join(', ')}），这些节点可能同时执行，导致同一条回复输出多次。` +
        `请只保留一个，或让它们挂到互斥的分支上`
      );
    }
  }

  // 7. HTTP 节点字段名（坑：system_httpHeaders 会被静默丢弃）
  for (const n of nodes) {
    if (n.flowNodeType !== 'httpRequest468') continue;
    const keys = (n.inputs || []).map(i => i.key);
    if (keys.includes('system_httpHeaders')) {
      errors.push(`${n.nodeId} 用了 system_httpHeaders，正确字段名是 system_httpHeader（单数），否则请求头会被静默丢弃`);
    }
    for (const need of ['system_httpReqUrl', 'system_httpMethod']) {
      if (!keys.includes(need)) errors.push(`${n.nodeId} 缺少 ${need}`);
    }
  }

  // 8. 变量引用格式（坑：{{$pluginInput.xxx$}} 不生效，必须用实际 nodeId）
  const raw = JSON.stringify(nodes);
  const badRefs = [...raw.matchAll(/\{\{\$(pluginInput|pluginOutput)\.([^$]+)\$\}\}/g)];
  for (const m of badRefs) {
    const io = [...byId.values()].find(x => x.flowNodeType === m[1]);
    const hint = io ? `（该节点的实际 nodeId 是 ${io.nodeId}）` : '';
    warnings.push(
      `变量引用 {{$${m[1]}.${m[2]}$}} 可能不生效${hint}。` +
      `应该写 {{$<实际nodeId>.${m[2]}$}}`
    );
  }

  // 9. 裸变量占位（服务端兼容，前端不认：不会渲染成变量芯片，依赖/校验都不统计）
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      const scan = s => {
        for (const m of s.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
          const defined = varKeys.has(m[1]);
          err(
            defined ? 'bare_variable_ref' : 'bare_variable_undefined',
            `${n.nodeId}.${inp.key} 用了裸变量占位 ${m[0]}` +
              (defined
                ? `，应写 {{$${VARIABLE_NODE_ID}.${m[1]}$}}（服务端能替换但前端不渲染成引用）`
                : `，且 chatConfig.variables 里没有 ${m[1]} 这个变量`),
            { fix: defined ? 'auto' : 'manual', where: `${n.nodeId}.${inp.key}`, variable: m[1] }
          );
        }
      };
      const walk = v => {
        if (typeof v === 'string') scan(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(inp.value);
    }
  }

  // 10. canEdit 动态输入不能用常量（前端只给引用选择器 -> 空占位 + 「存在未完成的输入变量配置」）
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.canEdit !== true) continue;
      if (isRef(inp.value)) continue;
      err(
        'canedit_const_value',
        `${n.nodeId}.${inp.key} 是 canEdit 动态输入，但值是常量 ${JSON.stringify(inp.value)}。` +
        `前端只会渲染引用选择器，会显示空的「选择引用变量」并报「存在未完成的输入变量配置」。` +
        `把常量内联进代码/节点参数后删掉这个输入项`,
        { where: `${n.nodeId}.${inp.key}`, nodeId: n.nodeId, inputKey: inp.key }
      );
    }
  }

  // 11. 动态输入容器不能是 null
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key === 'system_addInputParam' && inp.value == null) {
        err('addinputparam_null', `${n.nodeId}.system_addInputParam 的 value 是 null，前端动态输入表格按数组处理，应为 []`, { fix: 'auto', where: `${n.nodeId}.system_addInputParam` });
      }
    }
  }

  // 12. ifElse 条件值类型（schema：string | [nodeId, outputId]）
  for (const n of nodes) {
    if (n.flowNodeType !== 'ifElseNode') continue;
    const list = (n.inputs || []).find(i => i.key === 'ifElseList')?.value || [];
    for (const branch of list) {
      for (const item of branch.list || []) {
        if (item.value !== undefined && typeof item.value !== 'string' && !Array.isArray(item.value)) {
          err(
            'ifelse_value_type',
            `${n.nodeId}.ifElseList 分支 ${branch.branchId || '(无 branchId)'} 的 value 是 ${typeof item.value}` +
              `（${JSON.stringify(item.value)}），schema 只收 string 或 [nodeId, outputId]，布尔请写 "true"/"false"`,
            { fix: 'auto', where: `${n.nodeId}.ifElseList` }
          );
        }
        if (item.valueType && !['input', 'reference'].includes(item.valueType)) {
          err('ifelse_valuetype_enum', `${n.nodeId}.ifElseList valueType=${item.valueType}，只能是 input | reference`, { fix: 'auto', where: `${n.nodeId}.ifElseList` });
        }
      }
    }
  }

  // 12.5 selectedType / renderTypeList 必须在官方枚举内
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.selectedType && !INPUT_RENDER_TYPES.has(inp.selectedType)) {
        errors.push(
          `${n.nodeId}.${inp.key} 的 selectedType="${inp.selectedType}" 不在官方枚举内，服务端会直接报 Data validation error` +
          `（代码输入要用 "custom"，不是 "codeEditor"）`
        );
      }
      for (const rt of inp.renderTypeList || []) {
        if (typeof rt === 'string' && !INPUT_RENDER_TYPES.has(rt)) {
          errors.push(`${n.nodeId}.${inp.key} 的 renderTypeList 含非法值 "${rt}"`);
        }
      }
    }
  }

  // 12.7 code 节点的语法契约
  // 这三类错只有服务端 sandbox 才报，而且报的是 SyntaxError/ReferenceError，
  // 不说是哪个节点。本地能静态拦住，省掉「改一次跑一轮 API」。
  //
  // outputs 元素的 type / valueType 是服务端 zod 硬枚举：写错直接 400 "Data validation error"。
  // 以前这里完全不查，于是 lint 给假通行证、build 被服务端打回——最误导人的一类。
  const OUTPUT_TYPES = ['static', 'error', 'hidden', 'source', 'dynamic'];
  const OUTPUT_VALUE_TYPES = ['string', 'number', 'boolean', 'object', 'arrayString', 'arrayNumber',
    'arrayBoolean', 'arrayObject', 'arrayAny', 'any', 'chatHistory', 'datasetQuote', 'dynamic',
    'selectDataset', 'selectApp'];
  for (const n of nodes) {
    if (n.flowNodeType !== 'code') continue;

    // outputs 结构契约：先查，不依赖代码是否为空
    for (const [i, o] of (n.outputs || []).entries()) {
      const at = `${n.nodeId} 的 outputs[${i}]`;
      if (!o || typeof o !== 'object') { errors.push(`${at} 应该是对象（{id,key,type,valueType}）`); continue; }
      if (!o.id) errors.push(`${at} 缺 id（下游引用靠它定位）`);
      if (!o.key) errors.push(`${at} 缺 key（建议与 id 同值）`);
      if (!o.type) errors.push(`${at} 缺 type，自定义输出固定写 "static"`);
      else if (!OUTPUT_TYPES.includes(o.type)) {
        errors.push(`${at} 的 type="${o.type}" 不在服务端枚举内：${OUTPUT_TYPES.join(' | ')}`);
      }
      if (o.valueType && !OUTPUT_VALUE_TYPES.includes(o.valueType)) {
        errors.push(`${at} 的 valueType="${o.valueType}" 不在服务端枚举内：${OUTPUT_VALUE_TYPES.join(' | ')}`);
      }
    }

    const src = (n.inputs || []).find(i => i.key === 'code')?.value;
    if (typeof src !== 'string' || !src.trim()) continue;

    const mainMatch = /(?:async\s+)?function\s+main\s*\(\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)?\s*\)/.exec(src);
    if (!mainMatch) {
      errors.push(
        `${n.nodeId} 的代码没有定义 main 函数。FastGPT 约定是 function main({ 解构参数 }) {...}，` +
        `顶层 return 会在 sandbox 里报 (intermediate value)(...) is not a function`
      );
      continue;
    }

    const paramSrc = mainMatch[1] || '';
    const destructured = /^\{/.test(paramSrc)
      ? paramSrc.replace(/[{}]/g, '').split(',').map(x => x.split(/[:=]/)[0].trim()).filter(Boolean)
      : [];

    // 解构参数与内部变量重名 -> Identifier already declared
    const declared = [...src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
    const clash = [...new Set(destructured.filter(d => declared.includes(d)))];
    if (clash.length) {
      errors.push(
        `${n.nodeId} 的代码里 ${clash.join(' / ')} 与 main 的**解构参数重名**，运行时报 ` +
        `"Identifier 'X' has already been declared"。把内部变量改名（如 groupBy → gb）`
      );
    }

    // 用了 input.xxx，但参数是解构的 -> ReferenceError: input is not defined
    if (destructured.length && /\binput\s*\./.test(src)) {
      errors.push(
        `${n.nodeId} 的代码在解构参数模式下仍使用 input.xxx，运行时报 "input is not defined"。` +
        `直接用解构出来的变量名`
      );
    }

    // 声明了 outputs 就必须有对应 return 字段（只做单层粗检，嵌套对象不判）
    const declaredOutputs = (n.outputs || [])
      .map(o => o.id)
      .filter(id => id && id !== 'error' && !String(id).startsWith('system_'));
    if (declaredOutputs.length) {
      const ret = /return\s*\{([\s\S]*?)\}\s*;?\s*$/.exec(src.trim());
      if (ret) {
        const returned = ret[1];
        const missing = declaredOutputs.filter(k => !new RegExp(`\\b${k}\\s*[:,}]`).test(returned));
        if (missing.length) {
          warnings.push(`${n.nodeId} 声明了输出 ${missing.join(', ')}，但 return 里没有对应字段（下游引用会拿到 undefined）`);
        }
      }
    }
  }

  // 12.8 架构气味：把「自然语言理解」写进 code 节点 = 死工作流
  // 原则：AI 负责翻译成参数，工具只做执行。代码里出现意图识别/字段别名/中文问法正则，
  // 说明能力被写成了分支而不是工具——加一个维度就要改代码，长不大。
  const INTENT_SMELLS = [
    { re: /detect(ChartType|Intent|Dimension)|classifyQuestion|intentOf|parseIntent/i, why: '代码里在做意图识别/图型判断' },
    { re: /CATEGORY_FIELDS|FIELD_ALIASES|CATEGORY_ALIAS|字段别名|同义词表|SYNONYM/i, why: '代码里硬编码了业务字段或别名表' },
    { re: /\/(?:[^/\n]*)(上个月|近半年|各门店|占比|趋势|排行|最多)(?:[^/\n]*)\/[gimsuy]*/, why: '代码里用正则匹配中文问法' }
  ];
  for (const n of nodes) {
    if (n.flowNodeType !== 'code') continue;
    const src = (n.inputs || []).find(i => i.key === 'code')?.value;
    if (typeof src !== 'string' || src.length < 200) continue;
    const hits = INTENT_SMELLS.filter(x => x.re.test(src));
    if (hits.length) {
      warnings.push(
        `${n.nodeId} 的代码里疑似把「自然语言理解」写进了流程（${hits.map(h => h.why).join('；')}）。` +
        `原则：AI 只负责把话翻译成参数，能力全部做成工具；加能力就加工具，别在流程里加分支。` +
        `建议拆成：query 工具（过滤/聚合）+ render 工具（出图），意图交给 agent`
      );
    }
  }

  // 13. pluginModule：参数必须 agentGenerated，且必须用 selectedTools 连到 tools
  const selectedToolEdges = new Set(edges.filter(e => e.sourceHandle === 'selectedTools').map(e => e.target));
  for (const n of nodes) {
    if (n.flowNodeType !== 'pluginModule' && n.flowNodeType !== 'toolSet') continue;
    if (!selectedToolEdges.has(n.nodeId)) {
      errors.push(
        `${n.nodeId}(${n.name}) 是工具节点但没连到 tools 节点。` +
        `需要用 edges 添加 {source:"<tools节点>", sourceHandle:"selectedTools", target:"${n.nodeId}", targetHandle:"selectedTools"}`
      );
    }
    if (n.flowNodeType === 'pluginModule') {
      for (const inp of n.inputs || []) {
        if (inp.key === 'system_forbid_stream') continue;
        if (inp.selectedType !== 'agentGenerated') {
          warnings.push(
            `${n.nodeId}.${inp.key} 的 selectedType 是 "${inp.selectedType}"，` +
            `agent 传参会是空的；应设为 agentGenerated 并加 defaultToAgentGenerated: true`
          );
        }
      }
    }
  }

  // 14. 有 tools/pluginModule 但缺 answer 输出引用
  const toolsNodes = nodes.filter(n => n.flowNodeType === 'tools');
  for (const t of toolsNodes) {
    const used = nodes.some(n => n.flowNodeType === 'answerNode' &&
      (n.inputs || []).some(i => Array.isArray(i.value) && i.value[0] === t.nodeId));
    if (!used) warnings.push(`${t.nodeId} 的输出没有被 answerNode 引用，对话可能没有回复`);
  }

  // 15. 孤立节点
  const linked = new Set();
  for (const e of edges) { linked.add(e.source); linked.add(e.target); }
  for (const n of nodes) {
    if (!linked.has(n.nodeId)) warnings.push(`节点 ${n.nodeId}(${n.name}) 没有任何连线`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    issues,
    // 给调用方一句话动作：能自动修的走 lint --fix，不能修的要改内容
    next: errors.length === 0
      ? null
      : issues.some(i => i.fix === 'auto')
        ? `先跑 fastgpt wf lint <file> --fix fixed.json 自动修 ${issues.filter(i => i.fix === 'auto').length} 项，再改掉剩下的 ${issues.filter(i => i.fix !== 'auto').length} 项`
        : `${issues.length} 项都需要改内容（wf lint --fix 修不掉）：${[...new Set(issues.map(i => i.code))].join(', ')}`
  };
}

/**
 * 判断一组节点是否分属互斥分支。
 * 做法：从每个节点向上游回溯，收集途经的分支选择（sourceHandle 非 -source-right 的边）。
 * 如果两个节点经过同一个 classify 节点下的不同 key，则互斥。
 */
function checkMutuallyExclusive(nodeIds, nodes, edges) {
  const incoming = new Map();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push({ source: e.source, handle: e.sourceHandle || '' });
  }

  const collectBranches = startId => {
    const found = new Set();
    const seen = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const { source, handle } of incoming.get(cur) || []) {
        const m = /-source-(.+)$/.exec(handle);
        if (m && m[1] !== 'right') found.add(`${source}:${m[1]}`);
        stack.push(source);
      }
    }
    return found;
  };

  const sets = nodeIds.map(id => collectBranches(id));

  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const item of sets[i]) {
        const [src, key] = item.split(':');
        for (const other of sets[j]) {
          const [src2, key2] = other.split(':');
          if (src === src2 && key !== key2) return { exclusive: true };
        }
      }
    }
  }
  return { exclusive: false };
}

// ---------- 知识库引用校验（文件夹嵌套 / 引用形式） ----------
// 背景：白名单原先只查根目录（parentId: null），建在文件夹里的知识库一律被判「不存在」；
// 补上递归下钻后又会出现反向误判 —— 文件夹 id 被当 datasetId 塞进 datasets 照样通过。
// 两件事在这里收口：collectDatasetRefs 只回答「工作流里写了什么」，
// judgeDatasetRefs 只回答「拿白名单怎么判」，网络递归留给调用方。

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * 提取工作流里的知识库引用。
 * - 静态数组里的 datasetId 才是可校验的 id；
 * - [nodeId, outputId] 引用形式的值运行时才知道 → dynamic，绝不据此下「不存在」的结论；
 * - 非 24 位 ObjectId 的 id 仍然参与比对，但单独列入 suspect（占位符/手抄错位常见）。
 */
export function collectDatasetRefs(nodes = []) {
  const ids = new Set();
  const dynamic = [];
  const malformed = [];
  const suspect = [];
  for (const n of nodes) {
    for (const inp of n.inputs || []) {
      if (inp.key !== 'datasets') continue;
      const v = inp.value;
      if (isRef(v)) { dynamic.push({ node: n.nodeId, why: '引用形式 [nodeId, outputId]，值只有运行时才知道' }); continue; }
      if (!Array.isArray(v)) { dynamic.push({ node: n.nodeId, why: `datasets 值不是数组（${typeof v}），无法静态解析` }); continue; }
      for (const d of v) {
        const id = d && typeof d === 'object' ? d.datasetId : null;
        if (typeof id === 'string' && id.trim()) {
          ids.add(id);
          if (!OBJECT_ID_RE.test(id)) suspect.push({ node: n.nodeId, id });
        } else {
          malformed.push({ node: n.nodeId, value: d });
        }
      }
    }
  }
  return { ids: [...ids], dynamic, malformed, suspect };
}

/**
 * 拿白名单比对引用。
 * @param ids       collectDatasetRefs().ids
 * @param datasets  白名单里的真 dataset id（递归收集，含文件夹内嵌套库）
 * @param folders   白名单里的文件夹 id（只能下钻，不能当 datasetId 用）
 * @param errors    递归扫描时的失败项。非空 = 白名单不完整，此时任何「不存在」结论都不可信，
 *                  调用方必须放弃判定 —— 否则网络抖一下就把整份工作流判死。
 */
export function judgeDatasetRefs({ ids = [], datasets = [], folders = [], errors = [] } = {}) {
  const known = new Set(datasets);
  const folderSet = new Set(folders);
  const invalid = ids.filter(id => !known.has(id));
  return {
    checked: ids.length,
    invalid,
    folderRefs: invalid.filter(id => folderSet.has(id)),   // 把文件夹当知识库：误用，不是不存在
    notFound: invalid.filter(id => !folderSet.has(id)),    // 确实不在白名单里
    incomplete: errors.length > 0,
    errors
  };
}
