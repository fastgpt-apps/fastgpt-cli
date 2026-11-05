import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  normalizeImportPath,
  resolveDatasetId,
  coerceImportTagValue,
  readImportManifest,
  prepareImportJobs,
  executeTaggedImport
} from '../lib/import-tagged.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fastgpt-import-test-'));
}

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
