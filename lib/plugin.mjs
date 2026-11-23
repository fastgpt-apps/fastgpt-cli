// 工具市场插件（system tool）访问 + JSON Schema → pluginModule 参数转换
//
// 背景：FastGPT 的工具市场插件（markdown转文件、飞书webhook、DingTalkWebhook…）
// 是「系统工具」，走统一 API，schema 是标准 JSON Schema。用户把这些工具挂进工作流时，
// 需要构造 pluginModule 节点，其 inputs 必须按插件 inputSchema 生成——手写极易漏字段。
//
// 关键 API（抓自前端 chunk，实测可用）：
//   · GET /api/core/plugin/team/tool/list           团队可用工具列表（含 system 工具市场）
//   · GET /api/core/plugin/team/tool/detail?toolId= 工具详情（含 inputSchema/outputSchema/secretSchema）
//
// 设计目标：给一个 toolId（如 systemTool-markdownTransform），自动吐出一个可直接喂
// node.pluginModule() 的 { appId, params } —— params 从 inputSchema 推导，不再手抄。

/**
 * 把插件 inputSchema（JSON Schema object）转成 pluginModule 构造器需要的 params。
 * params 形如 [{ key, label, valueType, required, enum?, description? }]
 *
 * JSON Schema type → FastGPT valueType 映射（服务端只认这些）：
 *   string → string; number/integer → number; boolean → boolean;
 *   array → arrayString（按 items.type 细化）; object → object;
 *   enum（在 string 上）→ string + enum 候选
 */
const SCHEMA_TYPE_TO_VALUETYPE = (schema) => {
  const t = schema?.type;
  if (Array.isArray(t)) {
    if (t.includes('string')) return 'string';
    if (t.includes('number') || t.includes('integer')) return 'number';
    if (t.includes('boolean')) return 'boolean';
    return 'any';
  }
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  if (t === 'array') {
    const it = schema?.items?.type;
    if (it === 'number' || it === 'integer') return 'arrayNumber';
    if (it === 'boolean') return 'arrayBoolean';
    if (it === 'object') return 'arrayObject';
    return 'arrayString';
  }
  return 'any';
};

/**
 * inputSchema → params 数组。
 * @param {object} inputSchema  插件的 inputSchema（JSON Schema object）
 * @returns {Array<{key,label,valueType,required,enum?,description?,default?}>}
 */
export function inputSchemaToParams(inputSchema = {}) {
  const props = inputSchema?.properties || {};
  const required = new Set(inputSchema?.required || []);
  const params = [];
  for (const [key, sch] of Object.entries(props)) {
    // 只取标记为工具参数的（isToolParam !== false）；有些 schema 不标，默认都算
    if (sch?.isToolParam === false) continue;
    const zhTitle = sch?.['x-i18n']?.title?.['zh-CN'];
    params.push({
      key,
      label: zhTitle || sch?.title || key,
      valueType: SCHEMA_TYPE_TO_VALUETYPE(sch),
      required: required.has(key),
      enum: Array.isArray(sch?.enum) ? sch.enum : undefined,
      description: sch?.['x-i18n']?.description?.['zh-CN'] || sch?.description || '',
      default: sch?.default,
      // 原始 schema 片段，构造器里 customJsonSchema 用得上
      schema: sch,
    });
  }
  return params;
}

/**
 * 输出 schema → outputs 数组（pluginModule 的 outputs）。
 */
export function outputSchemaToOutputs(outputSchema = {}) {
  const props = outputSchema?.properties || {};
  const outs = Object.entries(props).map(([key, sch]) => {
    const zhTitle = sch?.['x-i18n']?.title?.['zh-CN'];
    return { id: key, key, label: zhTitle || sch?.title || key, type: 'static', valueType: SCHEMA_TYPE_TO_VALUETYPE(sch) };
  });
  // 插件一般至少有个原始响应壳；没有 schema 时给 result
  return outs.length ? outs : [{ id: 'result', key: 'result', label: '结果', type: 'static', valueType: 'object' }];
}

/**
 * 给定工具 detail，吐出一个可直接喂 node.pluginModule 的规格。
 * @param {object} detail  /api/core/plugin/team/tool/detail 的 data
 */
export function toolDetailToPluginSpec(detail = {}) {
  const isToolSet = !!detail.isToolSet;
  return {
    toolId: detail.id,
    version: detail.version,
    name: (detail.name && (detail.name['zh-CN'] || detail.name.en)) || detail.id,
    isToolSet,
    avatar: detail.avatar,
    params: inputSchemaToParams(detail.inputSchema || {}),
    outputs: outputSchemaToOutputs(detail.outputSchema || {}),
    secretSchema: detail.secretSchema || null,     // 需要鉴权的工具（如飞书 webhook）会带 secret
    // 工具集（isToolSet=true）需要先 getToolSetChildren 展开子工具，不能直接当 pluginModule
    note: isToolSet
      ? '这是工具集（toolSet），需先用 getToolSetChildren 展开子工具再逐个挂载，不能直接当 pluginModule'
      : '可直接用 node.pluginModule(id, { appId: toolId, params }) 挂载',
  };
}

/**
 * 从工具 detail 生成一个「人可读的参数速查表」，给 agent / 命令行输出用。
 */
export function describeParams(params = []) {
  return params.map(p => {
    const req = p.required ? '必填' : '可选';
    const en = p.enum ? ` 枚举[${p.enum.join('|')}]` : '';
    return `${p.key} (${p.valueType}, ${req})${en} — ${p.label}${p.description ? '：' + p.description.slice(0, 40) : ''}`;
  });
}
