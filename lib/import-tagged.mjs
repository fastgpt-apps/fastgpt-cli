import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import ExcelJS from 'exceljs';

const isBlank = value => value === null || value === undefined ||
  (typeof value === 'string' && value.trim() === '');
const defaultIgnoredColumnNames = new Set(['序号', '编号', '序列号', 'no.', 'no', 'index']);

function normalizedHeader(value) {
  return String(value ?? '').trim().toLowerCase();
}

function ignoredColumnSet(ignoreColumns = []) {
  const values = Array.isArray(ignoreColumns) ? ignoreColumns
    : typeof ignoreColumns === 'string' ? ignoreColumns.split(',') : [];
  return new Set([...defaultIgnoredColumnNames, ...values.filter(Boolean).map(normalizedHeader)]);
}

function cellValue(value) {
  if (value && typeof value === 'object' && 'result' in value) return value.result;
  if (value && typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text || '').join('');
  }
  return value;
}

export function normalizeImportPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('path 必须是非空相对路径');
  const normalized = value.trim().replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`path 必须是相对路径：${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`path 不允许空目录、. 或 ..：${value}`);
  }
  return parts.join('/');
}

function rowsFromWorksheet(worksheet, { pathColumn = 'path', datasetColumn = 'datasetId', ignoreColumns = [] } = {}) {
  if (!worksheet || worksheet.rowCount < 2) throw new Error('标签表至少需要一行表头和一行数据');
  const headers = worksheet.getRow(1).values.slice(1).map(cellValue)
    .map(value => String(value ?? '').replace(/^\uFEFF/, '').trim());
  if (!headers.length || headers.some(header => !header)) throw new Error('标签表表头不能为空');
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length) throw new Error(`标签表存在重复表头：${[...new Set(duplicates)].join(', ')}`);
  let resolvedPathColumn = pathColumn;
  if (!headers.includes(resolvedPathColumn) && pathColumn === 'path') {
    const aliases = ['文件路径', '文件相对路径', '相对路径', '路径', 'filePath', 'relativePath'];
    const matches = aliases.filter(alias => headers.includes(alias));
    if (matches.length === 1) resolvedPathColumn = matches[0];
    else if (matches.length > 1) throw new Error(`标签表存在多个可识别的路径列，请用 --path-column 指定：${matches.join(', ')}`);
  }
  if (!headers.includes(resolvedPathColumn)) throw new Error(`标签表必须包含 ${pathColumn} 列，值为相对目录的文件路径`);
  const ignored = ignoredColumnSet(ignoreColumns);

  const records = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw = {};
    headers.forEach((header, index) => { raw[header] = cellValue(row.getCell(index + 1).value); });
    if (Object.values(raw).every(isBlank)) return;
    const tags = Object.fromEntries(Object.entries(raw)
      .filter(([key, value]) => key !== resolvedPathColumn && key !== datasetColumn && key !== 'datasetId' &&
        !ignored.has(normalizedHeader(key)) && !isBlank(value)));
    records.push({ path: raw[resolvedPathColumn], datasetId: datasetColumn ? raw[datasetColumn] : undefined, tags, rowNumber });
  });
  return records;
}

export async function readImportManifest(filePath, { pathColumn = 'path', datasetColumn = 'datasetId', sheet, ignoreColumns = [] } = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`标签清单不存在：${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('JSON 标签清单必须是数组');
    return parsed.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`JSON 标签清单第 ${index + 1} 行必须是对象`);
      }
      const pathValue = record[pathColumn];
      const datasetId = datasetColumn ? record[datasetColumn] : undefined;
      const tags = record.tags && typeof record.tags === 'object'
        ? record.tags
        : Object.fromEntries(Object.entries(record).filter(([key, value]) =>
          key !== pathColumn && key !== datasetColumn && key !== 'datasetId' && key !== 'tags' &&
          !ignoredColumnSet(ignoreColumns).has(normalizedHeader(key)) && !isBlank(value)));
      return { path: pathValue, datasetId, tags, rowNumber: index + 1 };
    });
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = sheet ? (Number.isInteger(Number(sheet)) ? workbook.worksheets[Number(sheet) - 1] : workbook.getWorksheet(sheet)) : workbook.worksheets[0];
    if (!worksheet) throw new Error(`找不到工作表：${sheet}`);
    return rowsFromWorksheet(worksheet, { pathColumn, datasetColumn, ignoreColumns });
  }
  if (ext === '.csv') {
    const workbook = new ExcelJS.Workbook();
    const worksheet = await workbook.csv.readFile(filePath, { encoding: 'utf8' });
    return rowsFromWorksheet(worksheet, { pathColumn, datasetColumn, ignoreColumns });
  }
  throw new Error('清单仅支持 .xlsx、.xlsm、.csv 或 .json');
}

export function loadDatasetRoutes(filePath) {
  if (!filePath) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const routes = parsed?.routes ?? parsed;
  if (!routes || Array.isArray(routes) || typeof routes !== 'object') {
    throw new Error('routes JSON 必须是“目录名或相对目录路径: datasetId”的对象');
  }
  for (const [route, datasetId] of Object.entries(routes)) {
    if (!route.trim() || typeof datasetId !== 'string' || !datasetId.trim()) {
      throw new Error(`知识库路由无效：${route}`);
    }
  }
  return routes;
}

function routeMatches(directory, route) {
  const routePath = route.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  const segments = directory === '.' ? [] : directory.split('/');
  return segments.includes(routePath) || directory === routePath ||
    directory.startsWith(`${routePath}/`) || directory.includes(`/${routePath}/`) ||
    directory.endsWith(`/${routePath}`);
}

export function resolveDatasetId(relativePath, explicitDatasetId, routes = {}) {
  if (typeof explicitDatasetId === 'string' && explicitDatasetId.trim()) return explicitDatasetId.trim();
  const directory = path.posix.dirname(relativePath);
  const matches = Object.entries(routes).filter(([route]) => routeMatches(directory, route));
  if (!matches.length) throw new Error(`没有为文件匹配到 datasetId：${relativePath}`);
  const ids = [...new Set(matches.map(([, datasetId]) => datasetId))];
  if (ids.length > 1) throw new Error(`文件匹配到多个不同知识库路由：${relativePath}`);
  return ids[0];
}

function normalizeManifestPrefix(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('--manifest-prefix 必须是非空相对目录路径');
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return normalizeImportPath(normalized);
}

/** Select rows under a manifest path prefix and make their paths root-relative. */
export function selectManifestRecords(records, manifestPrefix) {
  if (!manifestPrefix) return records;
  const prefix = normalizeManifestPrefix(manifestPrefix);
  const selected = [];
  for (const record of records) {
    const manifestPath = normalizeImportPath(record.path);
    if (manifestPath === prefix) throw new Error(`清单路径前缀指向文件而非目录：${prefix}`);
    if (!manifestPath.startsWith(`${prefix}/`)) continue;
    const relativePath = manifestPath.slice(prefix.length + 1);
    selected.push({ ...record, path: relativePath, routePath: manifestPath });
  }
  if (!selected.length) throw new Error(`标签清单中没有路径匹配前缀：${prefix}`);
  return selected;
}

function discoverImportFiles(rootPath, ignorePaths = []) {
  const root = path.resolve(rootPath);
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error(`资料路径不是目录：${rootPath}`);
  const ignored = new Set(ignorePaths.map(item => path.resolve(item)));
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(directory, entry.name);
      if (ignored.has(path.resolve(fullPath)) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(path.relative(root, fullPath).split(path.sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

function pathSuffixLength(left, right) {
  const a = left.split('/').filter(Boolean);
  const b = right.split('/').filter(Boolean);
  let length = 0;
  while (length < a.length && length < b.length &&
    a[a.length - length - 1] === b[b.length - length - 1]) length++;
  return length;
}

/** Select a manifest subtree by matching every visible file beneath root exactly. */
export function selectManifestRecordsForRoot(records, rootPath, { manifestPrefix, ignorePaths = [] } = {}) {
  if (manifestPrefix) return selectManifestRecords(records, manifestPrefix);

  const localPaths = discoverImportFiles(rootPath, ignorePaths);
  if (!localPaths.length) throw new Error(`资料目录中没有可导入文件：${rootPath}`);
  const localPathSet = new Set(localPaths);
  const candidates = new Map();

  for (const record of records) {
    const manifestPath = normalizeImportPath(record.path);
    const segments = manifestPath.split('/');
    for (let start = 0; start < segments.length; start++) {
      const relativePath = segments.slice(start).join('/');
      if (!localPathSet.has(relativePath)) continue;
      const prefix = segments.slice(0, start).join('/');
      if (!candidates.has(prefix)) candidates.set(prefix, new Map());
      const matches = candidates.get(prefix);
      if (!matches.has(relativePath)) matches.set(relativePath, []);
      matches.get(relativePath).push({ ...record, manifestPath });
    }
  }

  const complete = [...candidates.entries()].filter(([, matches]) =>
    localPaths.every(relativePath => matches.get(relativePath)?.length === 1));
  if (!complete.length) {
    throw new Error(`无法根据资料目录中的文件路径自动匹配标签表；检查路径列与文件是否一一对应，或显式使用 --manifest-prefix：${rootPath}`);
  }

  const rootSegments = path.resolve(rootPath).split(path.sep).filter(Boolean).join('/');
  const ranked = complete.map(([prefix, matches]) => ({
    prefix,
    matches,
    score: pathSuffixLength(rootSegments, prefix)
  }));
  const bestScore = Math.max(...ranked.map(candidate => candidate.score));
  const best = ranked.filter(candidate => candidate.score === bestScore);
  if (best.length > 1) {
    throw new Error(`资料目录可匹配到多个标签表路径前缀，无法安全判断；请显式使用 --manifest-prefix：${best.map(item => item.prefix || '(无前缀)').join(', ')}`);
  }
  if (bestScore === 0 && best[0]?.prefix) {
    throw new Error(`无法根据资料目录名称确认标签表子目录；请调整目录名或显式使用 --manifest-prefix：${rootPath}`);
  }

  const prefix = best[0].prefix;
  const selected = [];
  for (const record of records) {
    const manifestPath = normalizeImportPath(record.path);
    if (prefix ? !manifestPath.startsWith(`${prefix}/`) : false) continue;
    if (prefix && manifestPath === prefix) throw new Error(`清单路径前缀指向文件而非目录：${prefix}`);
    const relativePath = prefix ? manifestPath.slice(prefix.length + 1) : manifestPath;
    selected.push({ ...record, path: relativePath, routePath: manifestPath });
  }
  return selected;
}

export function applyImportDatasetId(records, datasetId) {
  const target = String(datasetId ?? '').trim();
  if (!target) throw new Error('--dataset-id 必须是非空知识库 ID');
  return records.map(record => {
    const manifestDatasetId = String(record.datasetId ?? '').trim();
    if (manifestDatasetId && manifestDatasetId !== target) {
      throw new Error(`标签表第 ${record.rowNumber ?? '?'} 行的 datasetId 与 --dataset-id 不一致：${manifestDatasetId} != ${target}`);
    }
    return { ...record, datasetId: target };
  });
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Pick a dataset-scoped default state file while honoring a matching legacy state file. */
export function resolveImportStatePath({ rootPath, datasetIds = [], explicitPath, identity }) {
  const root = path.resolve(rootPath);
  const expectedIdentityHash = hashJson(identity);
  const readState = statePath => {
    if (!fs.existsSync(statePath)) return null;
    if (fs.lstatSync(statePath).isSymbolicLink()) throw new Error(`状态文件不能是符号链接：${statePath}`);
    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      throw new Error(`无法读取状态文件，拒绝自动开始新导入：${statePath}（${error.message}）`);
    }
    if (state.version !== 1 || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) {
      throw new Error(`状态文件格式无效，拒绝自动开始新导入：${statePath}`);
    }
    return state;
  };
  const assertCompatible = (statePath, state) => {
    if (state && state.identityHash !== expectedIdentityHash) {
      throw new Error(`状态文件与当前目录/清单/路由不匹配：${statePath}`);
    }
  };
  if (explicitPath) {
    const customPath = path.resolve(explicitPath);
    assertCompatible(customPath, readState(customPath));
    return customPath;
  }
  const uniqueDatasetIds = [...new Set(datasetIds.map(id => String(id).trim()).filter(Boolean))].sort();
  const legacyPath = path.join(root, '.fastgpt-import-state.json');
  if (!uniqueDatasetIds.length) {
    assertCompatible(legacyPath, readState(legacyPath));
    return legacyPath;
  }

  const scopedPath = path.join(root,
    `.fastgpt-import-state-${hashJson(uniqueDatasetIds).slice(0, 12)}.json`);
  const scopedState = readState(scopedPath);
  if (scopedState) {
    assertCompatible(scopedPath, scopedState);
    return scopedPath;
  }

  const legacyState = readState(legacyPath);
  const existingDatasetIds = new Set(Object.values(legacyState?.records || {})
    .map(record => String(record?.datasetId || '').trim()).filter(Boolean));
  const overlapsCurrentTargets = uniqueDatasetIds.some(id => existingDatasetIds.has(id));
  if (legacyState?.identityHash === expectedIdentityHash &&
      [...existingDatasetIds].every(id => uniqueDatasetIds.includes(id))) return legacyPath;
  if (overlapsCurrentTargets) {
    throw new Error(`旧状态文件包含当前目标知识库的记录，但导入配置不同；为避免重复上传，请检查旧任务或显式指定 --state：${legacyPath}`);
  }
  return scopedPath;
}

export function coerceImportTagValue(tagType, raw, arrayDelimiter = ';') {
  const value = cellValue(raw);
  if (isBlank(value)) return undefined;
  switch (tagType) {
    case 'number': {
      const number = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(number)) throw new Error(`标签值不是有效数字：${String(value)}`);
      return number;
    }
    case 'datetime': {
      const timestamp = value instanceof Date ? value.getTime()
        : /^\d+$/.test(String(value).trim()) ? Number(value) : Date.parse(value);
      if (!Number.isFinite(timestamp)) throw new Error(`标签日期无法解析：${String(value)}`);
      return timestamp;
    }
    case 'array': {
      let items;
      if (Array.isArray(value)) items = value;
      else {
        const text = String(value).trim();
        if (text.startsWith('[')) {
          try {
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) throw new Error('JSON 数组标签必须是数组');
            items = parsed;
          } catch (error) {
            if (error.message === 'JSON 数组标签必须是数组') throw error;
            throw new Error(`数组标签 JSON 格式错误：${text}`);
          }
        } else items = text.split(arrayDelimiter).map(item => item.trim()).filter(Boolean);
      }
      const normalized = items.map(item => String(item).trim()).filter(Boolean);
      if (!normalized.length) throw new Error('数组标签至少需要一个值');
      return normalized;
    }
    default:
      return String(value).trim();
  }
}

export async function prepareImportJobs({ rootPath, records, routes = {}, schemas, arrayDelimiter = ';', ignorePaths = [] }) {
  const root = path.resolve(rootPath);
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error(`资料路径不是目录：${rootPath}`);
  const realRoot = fs.realpathSync(root);
  if (!Array.isArray(records) || !records.length) throw new Error('标签清单没有文档记录');

  const seen = new Set();
  const jobs = [];
  for (const record of records) {
    const relativePath = normalizeImportPath(record.path);
    if (seen.has(relativePath)) throw new Error(`标签清单 path 重复：${relativePath}`);
    seen.add(relativePath);
    const fullPath = path.resolve(root, ...relativePath.split('/'));
    if (!fullPath.startsWith(root + path.sep)) throw new Error(`文件路径越出资料目录：${relativePath}`);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(`清单文件不存在：${relativePath}`);
    if (!fs.realpathSync(fullPath).startsWith(realRoot + path.sep)) throw new Error(`文件符号链接越出资料目录：${relativePath}`);
    if (!record.tags || typeof record.tags !== 'object' || Array.isArray(record.tags)) {
      throw new Error(`清单第 ${record.rowNumber ?? '?'} 行没有标签：${relativePath}`);
    }
    const tagEntries = Object.entries(record.tags).filter(([, raw]) => !isBlank(cellValue(raw)));
    if (!tagEntries.length) throw new Error(`清单第 ${record.rowNumber ?? '?'} 行没有标签：${relativePath}`);
    const datasetId = resolveDatasetId(record.routePath || relativePath, record.datasetId, routes);
    const schema = schemas.get(datasetId);
    if (!schema) throw new Error(`知识库标签维度尚未加载：${datasetId}`);
    const tags = tagEntries.map(([name, raw]) => {
      const definition = schema.get(name);
      if (!definition) throw new Error(`知识库 ${datasetId} 中不存在标签「${name}」`);
      const value = coerceImportTagValue(definition.tagType || 'string', raw, arrayDelimiter);
      if (value === undefined) throw new Error(`标签「${name}」没有值：${relativePath}`);
      return { tagId: definition.tagId || definition._id, tag: name, tagType: definition.tagType || 'string', value };
    });
    jobs.push({ path: relativePath, fullPath, datasetId, tags });
  }

  const discovered = new Set(discoverImportFiles(root, ignorePaths));
  const unlisted = [...discovered].filter(file => !seen.has(file));
  if (unlisted.length) throw new Error(`有 ${unlisted.length} 个非隐藏文件未出现在标签清单中：${unlisted.slice(0, 10).join(', ')}`);
  const missingFromDisk = [...seen].filter(file => !discovered.has(file));
  if (missingFromDisk.length) throw new Error(`标签清单中有文件未能安全扫描：${missingFromDisk.slice(0, 10).join(', ')}`);
  return jobs;
}

function acquireImportLock(lockPath) {
  fs.mkdirSync(path.dirname(path.resolve(lockPath)), { recursive: true });
  const lockId = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ lockId, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }));
    } catch (writeError) {
      try { fs.closeSync(fd); } catch {}
      fd = undefined;
      try { fs.unlinkSync(lockPath); } catch {}
      throw writeError;
    }
    return () => {
      try { fs.closeSync(fd); } catch {}
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (current.lockId === lockId) fs.unlinkSync(lockPath);
      } catch {}
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
    const owner = existing ? `PID ${existing.pid || '?'} @ ${existing.host || 'unknown host'}` : 'owner unavailable';
    throw new Error(`已有导入进程正在使用状态文件（${owner}，锁：${lockPath}）。确认没有其他导入进程后再重试；若上次异常退出且锁已失效，可删除此锁文件。`);
  }
}

function isCollectionNotFound(error) {
  return error?.statusText === 'unExistCollection' ||
    error?.subtype === 'collection_not_found' ||
    /unExistCollection|common:error_collection_not_exist/.test(error?.message || '');
}

export async function executeTaggedImport(options) {
  if (options.dryRun) return executeTaggedImportLocked(options);
  const releaseLock = acquireImportLock(options.lockPath || `${options.statePath}.lock`);
  try {
    return await executeTaggedImportLocked(options);
  } finally {
    releaseLock();
  }
}

async function executeTaggedImportLocked({ jobs, api, statePath, identity, dryRun = false, retryUncertainPath }) {
  if (dryRun) return { ok: true, dryRun: true, total: jobs.length, files: jobs.map(({ path: file, datasetId, tags }) => ({ file, datasetId, tags: tags.map(({ tag, value }) => ({ tag, value })) })) };

  const identityHash = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  let state = { version: 1, identityHash, records: {} };
  if (fs.existsSync(statePath)) {
    if (fs.lstatSync(statePath).isSymbolicLink()) throw new Error(`状态文件不能是符号链接：${statePath}`);
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.version !== 1 || state.identityHash !== identityHash) {
      throw new Error(`状态文件与当前目录/清单/路由不匹配：${statePath}`);
    }
    if (!state.records || typeof state.records !== 'object' || Array.isArray(state.records)) {
      throw new Error(`状态文件格式无效：${statePath}`);
    }
  }
  if (retryUncertainPath) {
    const retryRecord = state.records[retryUncertainPath];
    if (!jobs.some(job => job.path === retryUncertainPath) ||
        !['uploading', 'uncertain_upload'].includes(retryRecord?.status)) {
      throw new Error(`--retry-uncertain 必须指向状态为 uploading/uncertain_upload 的清单文件：${retryUncertainPath}`);
    }
  }
  const save = () => {
    fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, statePath);
  };

  let uploaded = 0;
  const failures = [];
  for (const job of jobs) {
    const prior = state.records[job.path];
    if (prior && !['pending', 'uploading', 'uncertain_upload', 'uploaded', 'tagged'].includes(prior.status)) {
      throw new Error(`状态文件中的文件状态无效：${job.path}`);
    }
    if (prior && ['uploaded', 'tagged'].includes(prior.status) && !prior.collectionId) {
      throw new Error(`状态文件缺少 collectionId：${job.path}`);
    }
    if (prior && ['uploading', 'uncertain_upload'].includes(prior.status) && prior.collectionId) {
      throw new Error(`状态文件在不确定上传状态下已有 collectionId，拒绝自动重试：${job.path}`);
    }
    const manifestHash = crypto.createHash('sha256').update(JSON.stringify(job.tags)).digest('hex');
    const fileBuffer = fs.readFileSync(job.fullPath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (prior?.collectionId && prior.datasetId !== job.datasetId) throw new Error(`文件已有上传记录但目标库已变化，拒绝复用：${job.path}`);
    if (prior && ['uploading', 'uncertain_upload'].includes(prior.status) && prior.datasetId !== job.datasetId) {
      throw new Error(`上传结果不确定期间目标知识库发生变化，拒绝重试：${job.path}`);
    }
    if (prior?.collectionId && prior.fileHash !== fileHash) throw new Error(`文件内容在上传后发生变化，拒绝覆盖远端文档：${job.path}`);
    if (!prior?.collectionId && prior?.fileHash && prior.fileHash !== fileHash &&
        ['uploading', 'uncertain_upload'].includes(prior.status)) {
      throw new Error(`上传结果不确定期间本地文件发生变化，拒绝重试：${job.path}`);
    }
    let record = prior || {
      datasetId: job.datasetId,
      manifestHash,
      fileHash,
      status: 'pending'
    };
    if (record.manifestHash !== manifestHash) {
      record.manifestHash = manifestHash;
      if (record.collectionId) record.status = 'uploaded';
    }
    record.datasetId = job.datasetId;
    record.fileHash = fileHash;
    state.records[job.path] = record;

    const uncertainUpload = ['uploading', 'uncertain_upload'].includes(record.status);
    if (uncertainUpload && retryUncertainPath !== job.path) {
      record.status = 'uncertain_upload';
      failures.push({ file: job.path, stage: 'upload', error: '上传结果不确定。先在 FastGPT 核实是否已创建，再用 --retry-uncertain <path> 明确重试' });
      save();
      break;
    }
    if (record.status === 'pending' || (uncertainUpload && retryUncertainPath === job.path)) {
      record.status = 'uploading';
      save();
      try {
        const result = await api.upload({ ...job, buffer: fileBuffer });
        if (!result?.collectionId) throw new Error('FastGPT 上传响应没有 collectionId');
        record.collectionId = result.collectionId;
        record.status = 'uploaded';
        uploaded++;
        save();
      } catch (error) {
        record.status = 'uncertain_upload';
        record.uploadError = error.message;
        save();
        failures.push({ file: job.path, stage: 'upload', error: error.message, uncertain: true });
        break;
      }
    }
    try {
      let actual;
      try {
        actual = await api.getTags(record.collectionId);
      } catch (error) {
        if (!record.collectionId || !isCollectionNotFound(error)) throw error;

        const staleCollectionId = record.collectionId;
        record.supersededCollectionIds = [...new Set([...(record.supersededCollectionIds || []), staleCollectionId])];
        delete record.collectionId;
        delete record.taggedAt;
        delete record.tagError;
        record.status = 'pending';
        save();

        record.status = 'uploading';
        save();
        let replacement;
        try {
          replacement = await api.upload({ ...job, buffer: fileBuffer });
          if (!replacement?.collectionId) throw new Error('FastGPT 上传响应没有 collectionId');
        } catch (uploadError) {
          record.status = 'uncertain_upload';
          record.uploadError = uploadError.message;
          save();
          failures.push({ file: job.path, stage: 'upload', error: uploadError.message, uncertain: true });
          break;
        }

        record.collectionId = replacement.collectionId;
        record.status = 'uploaded';
        record.fileHash = fileHash;
        uploaded++;
        save();
        actual = await api.getTags(record.collectionId);
      }
      const isApplied = () => job.tags.every(expected => actual.some(item =>
        item.tag === expected.tag && isDeepStrictEqual(item.value, expected.value)));
      if (!isApplied()) {
        await api.setTags({ datasetId: job.datasetId, collectionId: record.collectionId, tags: job.tags });
        actual = await api.getTags(record.collectionId);
        if (!isApplied()) throw new Error('写入后回读标签不匹配');
      }
      record.status = 'tagged';
      record.taggedAt = new Date().toISOString();
      save();
    } catch (error) {
      record.status = 'uploaded';
      record.tagError = error.message;
      failures.push({ file: job.path, stage: 'tag', collectionId: record.collectionId, error: error.message });
      save();
    }
  }
  const completed = jobs.filter(job => state.records[job.path]?.status === 'tagged').length;
  return { ok: failures.length === 0 && completed === jobs.length, total: jobs.length, uploaded, tagged: completed, failed: failures.length, failures, statePath };
}
