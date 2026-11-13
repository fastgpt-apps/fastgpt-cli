import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { encodeMultipartFilename, multipartFileHeader } from '../lib/multipart.mjs';
import {
  normalizeImportPath,
  resolveDatasetId,
  coerceImportTagValue,
  readImportManifest,
  selectManifestRecords,
  selectManifestRecordsForRoot,
  applyImportDatasetId,
  resolveImportStatePath,
  prepareImportJobs,
  executeTaggedImport
} from '../lib/import-tagged.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fastgpt-import-test-'));
}

test('encodes multipart filenames according to RFC 5987', () => {
  const name = "2024年10月刊-聚焦'行为改变' 让培训回归基本面.pdf";
  const encoded = encodeMultipartFilename(name);
  assert.equal(encoded.includes("'"), false);
  assert.equal(encoded.includes('%27'), true);
  const header = multipartFileHeader('boundary', { name });
  const text = header.toString('utf8');
  assert.match(text, /filename\*=UTF-8''/);
  assert.equal(text.includes("filename*=UTF-8''" + encoded), true);

  const unsafeHeader = multipartFileHeader('boundary', { name: 'a"b\r\nX-Injected: yes.pdf' }).toString('utf8');
  assert.match(unsafeHeader, /filename="a\\"b__X-Injected: yes\.pdf"/);
  assert.equal(unsafeHeader.includes('\r\nX-Injected: yes.pdf'), false);
});

test('normalizes platform separators and rejects unsafe relative paths', () => {
  assert.equal(normalizeImportPath('2026\\案例库\\a.pdf'), '2026/案例库/a.pdf');
  assert.throws(() => normalizeImportPath('../outside.pdf'), /不允许/);
  assert.throws(() => normalizeImportPath('/tmp/outside.pdf'), /相对路径/);
});

test('routes by exact directory name and rejects conflicting routes', () => {
  assert.equal(resolveDatasetId('2026-案例库/a.pdf', undefined, { '2026-案例库': 'ds-case' }), 'ds-case');
  assert.equal(resolveDatasetId('2026/2026-案例库/a.pdf', undefined, { '2026-案例库': 'ds-case' }), 'ds-case');
  assert.equal(resolveDatasetId('2026/2026-案例库/a.pdf', 'ds-explicit', { '2026-案例库': 'ds-case' }), 'ds-explicit');
  assert.throws(() => resolveDatasetId('2026/2026-案例库/a.pdf', undefined, { '2026-案例库': 'a', '2026': 'b' }), /多个不同知识库/);
});

test('coerces typed labels and rejects invalid values', () => {
  assert.equal(coerceImportTagValue('number', '12.5'), 12.5);
  assert.equal(coerceImportTagValue('datetime', new Date('2026-01-01T00:00:00Z')), Date.parse('2026-01-01T00:00:00Z'));
  assert.deepEqual(coerceImportTagValue('array', '法务;财务'), ['法务', '财务']);
  assert.deepEqual(coerceImportTagValue('array', '["A","B"]'), ['A', 'B']);
  assert.throws(() => coerceImportTagValue('number', 'NaN'), /数字/);
  assert.throws(() => coerceImportTagValue('array', '[]'), /至少需要/);
});

test('reads CSV and Excel manifests, including custom headers and nested paths', async () => {
  const dir = tempDir();
  try {
    const csvPath = path.join(dir, 'tags.csv');
    fs.writeFileSync(csvPath, '文件路径,知识库ID,分类,适用部门\n2026-案例库/a.pdf,ds-case,案例,法务;财务\n');
    const csv = await readImportManifest(csvPath, { pathColumn: '文件路径', datasetColumn: '知识库ID' });
    assert.equal(csv[0].path, '2026-案例库/a.pdf');
    assert.equal(csv[0].datasetId, 'ds-case');
    assert.deepEqual(csv[0].tags, { 分类: '案例', 适用部门: '法务;财务' });

    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('标签');
    sheet.addRow(['文件相对路径', '目标知识库', '分类']);
    sheet.addRow(['2026-案例库/a.pdf', 'ds-case', '案例']);
    const xlsxPath = path.join(dir, 'tags.xlsx');
    await book.xlsx.writeFile(xlsxPath);
    const xlsx = await readImportManifest(xlsxPath, { pathColumn: '文件相对路径', datasetColumn: '目标知识库', sheet: '标签' });
    assert.equal(xlsx[0].path, '2026-案例库/a.pdf');
    assert.equal(xlsx[0].datasetId, 'ds-case');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-detects common Chinese path headers when the default path column is used', async () => {
  const dir = tempDir();
  try {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('分类总表');
    sheet.addRow(['序号', '文件路径', '分类', '备注']);
    sheet.addRow([1, '2026/方法库/a.pdf', '方法', '仅用于说明']);
    const manifestPath = path.join(dir, 'tags.xlsx');
    await book.xlsx.writeFile(manifestPath);
    const records = await readImportManifest(manifestPath);
    assert.equal(records[0].path, '2026/方法库/a.pdf');
    assert.deepEqual(records[0].tags, { 分类: '方法', 备注: '仅用于说明' });
    const ignoredRecords = await readImportManifest(manifestPath, { ignoreColumns: '备注, 来源' });
    assert.deepEqual(ignoredRecords[0].tags, { 分类: '方法' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('selects a prefixed subtree from a full manifest and keeps the original route path', () => {
  const records = [
    { path: '2026年杂志分类/2026-方法库/a.pdf', tags: { 分类: '方法' }, rowNumber: 2 },
    { path: '2026年杂志分类/2026-案例库/b.pdf', tags: { 分类: '案例' }, rowNumber: 3 }
  ];
  const selected = selectManifestRecords(records, '2026年杂志分类\\2026-方法库/');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].path, 'a.pdf');
  assert.equal(selected[0].routePath, '2026年杂志分类/2026-方法库/a.pdf');
  assert.throws(() => selectManifestRecords(records, '../2026'), /不允许/);
  assert.throws(() => selectManifestRecords(records, 'missing'), /没有路径匹配前缀/);
});

test('auto-selects the matching manifest subtree using the directory path, not duplicate filenames', () => {
  const parent = tempDir();
  const root = path.join(parent, '2024-2026杂志分类', '2026年杂志分类', '2026-案例库');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.pdf'), 'a');
  fs.writeFileSync(path.join(root, 'b.pdf'), 'b');
  try {
    const records = [
      { path: '2024年杂志分类/2024-案例库/a.pdf', tags: { 分类: '旧案例' }, rowNumber: 2 },
      { path: '2024年杂志分类/2024-案例库/b.pdf', tags: { 分类: '旧案例' }, rowNumber: 3 },
      { path: '2025年杂志分类/2025-案例库/a.pdf', tags: { 分类: '去年案例' }, rowNumber: 4 },
      { path: '2025年杂志分类/2025-案例库/b.pdf', tags: { 分类: '去年案例' }, rowNumber: 5 },
      { path: '2026年杂志分类/2026-案例库/a.pdf', tags: { 分类: '今年案例' }, rowNumber: 6 },
      { path: '2026年杂志分类/2026-案例库/b.pdf', tags: { 分类: '今年案例' }, rowNumber: 7 }
    ];
    const selected = selectManifestRecordsForRoot(records, root);
    assert.deepEqual(selected.map(record => record.path), ['a.pdf', 'b.pdf']);
    assert.ok(selected.every(record => record.routePath.startsWith('2026年杂志分类/2026-案例库/')));
    assert.ok(selected.every(record => record.tags['分类'] === '今年案例'));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('requires a prefix when multiple manifest subtrees match a moved directory', () => {
  const parent = tempDir();
  const root = path.join(parent, 'case');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.pdf'), 'a');
  try {
    const records = [
      { path: '2025-案例库/a.pdf', tags: { 分类: '2025' } },
      { path: '2026-案例库/a.pdf', tags: { 分类: '2026' } }
    ];
    assert.throws(() => selectManifestRecordsForRoot(records, root), /多个标签表路径前缀/);
    assert.equal(selectManifestRecordsForRoot(records, root, { manifestPrefix: '2026-案例库' })[0].tags['分类'], '2026');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('applies a single target dataset and rejects conflicting manifest IDs', () => {
  const records = [
    { path: 'a.pdf', datasetId: undefined },
    { path: 'b.pdf', datasetId: 'dataset-1', rowNumber: 3 }
  ];
  assert.deepEqual(applyImportDatasetId(records, 'dataset-1').map(record => record.datasetId), ['dataset-1', 'dataset-1']);
  assert.throws(() => applyImportDatasetId(records, 'dataset-2'), /与 --dataset-id 不一致/);
  assert.throws(() => applyImportDatasetId(records, '  '), /非空知识库 ID/);
});

test('chooses state automatically per dataset and reuses only a matching legacy state', () => {
  const root = tempDir();
  try {
    const identity = { root, base: 'https://fastgpt.example.com', routesHash: 'routes-hash' };
    const automaticPath = resolveImportStatePath({ rootPath: root, datasetIds: ['dataset-a'], identity });
    assert.match(path.basename(automaticPath), /^\.fastgpt-import-state-[a-f0-9]{12}\.json$/);
    assert.notEqual(automaticPath,
      resolveImportStatePath({ rootPath: root, datasetIds: ['dataset-b'], identity }));

    const legacyPath = path.join(root, '.fastgpt-import-state.json');
    const identityHash = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    fs.writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      identityHash,
      records: { 'a.pdf': { datasetId: 'dataset-a', status: 'tagged' } }
    }));
    assert.equal(resolveImportStatePath({ rootPath: root, datasetIds: ['dataset-a'], identity }), legacyPath);

    const otherIdentity = { ...identity, routesHash: 'other-routes' };
    assert.throws(() => resolveImportStatePath({ rootPath: root, datasetIds: ['dataset-a'], identity: otherIdentity }), /避免重复上传/);
    assert.notEqual(resolveImportStatePath({ rootPath: root, datasetIds: ['dataset-b', 'dataset-c'], identity }), legacyPath);
    assert.equal(resolveImportStatePath({ rootPath: root, datasetIds: ['dataset-a'], explicitPath: path.join(root, 'custom.json'), identity }),
      path.join(root, 'custom.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preflight requires every visible file to have tags and a valid route', async () => {
  const root = tempDir();
  try {
    fs.mkdirSync(path.join(root, '2026-案例库'));
    fs.writeFileSync(path.join(root, '2026-案例库', 'a.pdf'), 'pdf');
    fs.writeFileSync(path.join(root, '2026-案例库', 'unlisted.pdf'), 'pdf');
    const schemas = new Map([['ds-case', new Map([['分类', { tagId: 'tag-1', tagType: 'string' }]])]]);
    const record = { path: '2026-案例库/a.pdf', tags: { 分类: '案例' }, rowNumber: 2 };
    await assert.rejects(prepareImportJobs({ rootPath: root, records: [record], routes: { '2026-案例库': 'ds-case' }, schemas }), /未出现在标签清单/);
    fs.unlinkSync(path.join(root, '2026-案例库', 'unlisted.pdf'));
    const jobs = await prepareImportJobs({ rootPath: root, records: [record], routes: { '2026-案例库': 'ds-case' }, schemas });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].datasetId, 'ds-case');
    assert.equal(jobs[0].tags[0].tagId, 'tag-1');
    await assert.rejects(prepareImportJobs({ rootPath: root, records: [record, record], routes: { '2026-案例库': 'ds-case' }, schemas }), /path 重复/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preflights a selected manifest subtree against a nested root and routes by the original path', async () => {
  const root = tempDir();
  try {
    fs.writeFileSync(path.join(root, 'a.pdf'), 'pdf');
    const records = selectManifestRecords([
      { path: '2026年杂志分类/2026-方法库/a.pdf', tags: { 分类: '方法' }, rowNumber: 2 },
      { path: '2026年杂志分类/2026-案例库/b.pdf', tags: { 分类: '案例' }, rowNumber: 3 }
    ], '2026年杂志分类/2026-方法库');
    const schemas = new Map([['ds-method', new Map([['分类', { tagId: 'tag-1', tagType: 'string' }]])]]);
    const jobs = await prepareImportJobs({
      rootPath: root,
      records,
      routes: { '2026-方法库': 'ds-method' },
      schemas
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].path, 'a.pdf');
    assert.equal(jobs[0].fullPath, path.join(root, 'a.pdf'));
    assert.equal(jobs[0].datasetId, 'ds-method');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run does not call APIs or write state', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    fs.writeFileSync(file, 'pdf');
    const statePath = path.join(root, '.state.json');
    const jobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags: [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }] }];
    const api = { upload: () => assert.fail('dry-run 不应上传'), setTags: () => assert.fail('dry-run 不应写标签'), getTags: () => assert.fail('dry-run 不应回读') };
    const result = await executeTaggedImport({ jobs, api, statePath, identity: { root }, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hashes and uploads the same file buffer', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    const original = Buffer.from('original bytes');
    fs.writeFileSync(file, original);
    const statePath = path.join(root, '.state.json');
    const jobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags: [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }] }];
    let uploadedBuffer;
    const api = {
      upload: async job => {
        uploadedBuffer = job.buffer;
        fs.writeFileSync(file, 'changed after buffer read');
        return { collectionId: 'collection-1' };
      },
      setTags: async ({ tags }) => { api.stored = tags.map(tag => ({ tag: '分类', value: tag.value })); },
      getTags: async () => api.stored || []
    };
    const result = await executeTaggedImport({ jobs, api, statePath, identity: { root } });
    assert.equal(result.ok, true);
    assert.deepEqual(uploadedBuffer, original);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).records['a.pdf'].fileHash,
      crypto.createHash('sha256').update(original).digest('hex'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resumes after a tag write failure without re-uploading', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    fs.writeFileSync(file, 'pdf');
    const statePath = path.join(root, '.state.json');
    const jobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags: [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }] }];
    let uploads = 0;
    let writes = 0;
    let stored = [];
    const api = {
      upload: async () => ({ collectionId: `collection-${++uploads}` }),
      setTags: async ({ tags }) => {
        writes++;
        if (writes === 1) throw new Error('temporary tag failure');
        stored = tags.map(tag => ({ tag: '分类', value: tag.value }));
      },
      getTags: async () => stored
    };
    const identity = { root, routes: {} };
    const first = await executeTaggedImport({ jobs, api, statePath, identity });
    assert.equal(first.ok, false);
    assert.equal(uploads, 1);
    const second = await executeTaggedImport({ jobs, api, statePath, identity });
    assert.equal(second.ok, true);
    assert.equal(uploads, 1);
    assert.equal(second.tagged, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reuploads when a saved collectionId no longer exists remotely', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    const fileBytes = Buffer.from('pdf bytes');
    fs.writeFileSync(file, fileBytes);
    const statePath = path.join(root, '.state.json');
    const identity = { root };
    const tags = [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }];
    const fileHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
    const manifestHash = crypto.createHash('sha256').update(JSON.stringify(tags)).digest('hex');
    const identityHash = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      identityHash,
      records: { 'a.pdf': { datasetId: 'ds', collectionId: 'stale-id', fileHash, manifestHash, status: 'uploaded' } }
    }));

    let uploads = 0;
    let stored = [];
    const api = {
      upload: async () => ({ collectionId: `replacement-${++uploads}` }),
      getTags: async collectionId => {
        if (collectionId === 'stale-id') {
          const error = new Error('unExistCollection common:error_collection_not_exist');
          error.statusText = 'unExistCollection';
          throw error;
        }
        return stored;
      },
      setTags: async ({ tags: applied }) => { stored = applied.map(tag => ({ tag: '分类', value: tag.value })); }
    };

    const result = await executeTaggedImport({
      jobs: [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags }],
      api,
      statePath,
      identity
    });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.uploaded, 1);
    assert.equal(result.tagged, 1);
    assert.equal(uploads, 1);
    assert.equal(state.records['a.pdf'].collectionId, 'replacement-1');
    assert.deepEqual(state.records['a.pdf'].supersededCollectionIds, ['stale-id']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rechecks tagged state against FastGPT and repairs missing tags without re-uploading', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    fs.writeFileSync(file, 'pdf');
    const statePath = path.join(root, '.state.json');
    const jobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags: [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }] }];
    let uploads = 0;
    let writes = 0;
    let stored = [];
    const api = {
      upload: async () => ({ collectionId: `collection-${++uploads}` }),
      setTags: async ({ tags }) => { writes++; stored = tags.map(tag => ({ tag: '分类', value: tag.value })); },
      getTags: async () => stored
    };
    const identity = { root };
    assert.equal((await executeTaggedImport({ jobs, api, statePath, identity })).ok, true);
    stored = [];
    const rerun = await executeTaggedImport({ jobs, api, statePath, identity });
    assert.equal(rerun.ok, true);
    assert.equal(uploads, 1);
    assert.equal(writes, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a concurrent run holding the same state lock', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    fs.writeFileSync(file, 'pdf');
    const statePath = path.join(root, '.state.json');
    const lockPath = path.join(root, '.import.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ lockId: crypto.randomUUID(), pid: process.pid, host: os.hostname() }));
    const jobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags: [] }];
    const api = { upload: () => assert.fail('被锁时不应上传') };
    await assert.rejects(executeTaggedImport({ jobs, api, statePath, lockPath, identity: { root } }), /已有导入进程正在使用状态文件/);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('marks ambiguous upload failures and requires explicit retry', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    fs.writeFileSync(file, 'pdf');
    const statePath = path.join(root, '.state.json');
    const jobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags: [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }] }];
    let uploads = 0;
    const api = {
      upload: async () => {
        uploads++;
        if (uploads === 1) throw new Error('socket closed after request');
        return { collectionId: 'collection-2' };
      },
      setTags: async ({ tags }) => { api.stored = tags.map(tag => ({ tag: '分类', value: tag.value })); },
      getTags: async () => api.stored || []
    };
    const identity = { root };
    const first = await executeTaggedImport({ jobs, api, statePath, identity });
    assert.equal(first.failures[0].uncertain, true);
    const blocked = await executeTaggedImport({ jobs, api, statePath, identity });
    assert.equal(blocked.failed, 1);
    assert.equal(uploads, 1);
    const retried = await executeTaggedImport({ jobs, api, statePath, identity, retryUncertainPath: 'a.pdf' });
    assert.equal(retried.ok, true);
    assert.equal(uploads, 2);
    await assert.rejects(executeTaggedImport({ jobs, api, statePath, identity, retryUncertainPath: 'missing.pdf' }), /--retry-uncertain 必须指向/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to retry an uncertain upload after the local file changes', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    fs.writeFileSync(file, 'original');
    const statePath = path.join(root, '.state.json');
    const jobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'ds', tags: [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }] }];
    const api = {
      upload: async () => { throw new Error('connection dropped'); },
      setTags: async () => {},
      getTags: async () => []
    };
    const identity = { root };
    await executeTaggedImport({ jobs, api, statePath, identity });
    fs.writeFileSync(file, 'changed');
    await assert.rejects(executeTaggedImport({ jobs, api, statePath, identity, retryUncertainPath: 'a.pdf' }), /本地文件发生变化/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to retry an uncertain upload after the target dataset changes', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'a.pdf');
    fs.writeFileSync(file, 'original');
    const statePath = path.join(root, '.state.json');
    const tags = [{ tagId: 'tag', tag: '分类', tagType: 'string', value: '案例' }];
    const api = {
      upload: async () => { throw new Error('connection dropped'); },
      setTags: async () => {},
      getTags: async () => []
    };
    const identity = { root };
    const firstJobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'dataset-a', tags }];
    await executeTaggedImport({ jobs: firstJobs, api, statePath, identity });
    const changedJobs = [{ path: 'a.pdf', fullPath: file, datasetId: 'dataset-b', tags }];
    await assert.rejects(executeTaggedImport({ jobs: changedJobs, api, statePath, identity, retryUncertainPath: 'a.pdf' }), /目标知识库发生变化/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
