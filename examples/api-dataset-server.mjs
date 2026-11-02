#!/usr/bin/env node
/**
 * FastGPT 第三方知识库（apiDataset）——外部文件服务参考实现
 *
 * FastGPT 只存索引，文件正文留在你自己的系统里。它通过 4 个接口读你的文件：
 *   POST /v1/file/list     { searchKey, parentId }        -> 文件列表
 *   GET  /v1/file/detail   ?id=                            -> 单个文件详情
 *   GET  /v1/file/content  ?id=                            -> 文件正文 { title, content }
 *   GET  /v1/file/read     ?id=                            -> 预览地址 { url }
 * 统一响应体：{ success: true, message: '', data: ... }
 * 鉴权：Authorization: Bearer <token>（token 就是建库时的 --api-token）
 *
 * 用法：
 *   KB_DIR=./docs KB_TOKEN=my-token PORT=18080 node examples/api-dataset-server.mjs
 *   # 公网暴露（FastGPT SaaS 需要）：cloudflared tunnel --url http://127.0.0.1:18080
 *   # 然后把 https://xxx.trycloudflare.com 填进 fastgpt ds create --api-base
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT) || 18080;
const TOKEN = process.env.KB_TOKEN || 'demo-token';
const ROOT = path.resolve(process.env.KB_DIR || './docs');
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.html', '.log', '.yaml', '.yml']);

if (!fs.existsSync(ROOT)) {
  console.error(`KB_DIR 不存在: ${ROOT}`);
  process.exit(1);
}

/** 相对路径做稳定 ID，避免重启后 ID 变化导致重复导入 */
const toId = (rel) => Buffer.from(rel || '/').toString('base64url');
const fromId = (id) => Buffer.from(id, 'base64url').toString('utf8');

/** 扫一层目录，返回 FastGPT 需要的文件项 */
function listDir(parentId, searchKey = '') {
  const rel = parentId ? fromId(parentId) : '/';
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const childRel = path.posix.join(rel, e.name);
      const isDir = e.isDirectory();
      const st = fs.statSync(path.join(ROOT, childRel));
      return {
        id: toId(childRel),
        parentId: rel === '/' ? null : toId(rel),
        name: e.name,
        type: isDir ? 'folder' : 'file',
        hasChild: isDir && fs.readdirSync(path.join(ROOT, childRel)).length > 0,
        updateTime: st.mtime.toISOString(),
        createTime: st.birthtime.toISOString()
      };
    })
    .filter((f) => !searchKey || f.name.includes(searchKey))
    .filter((f) => f.type === 'folder' || TEXT_EXT.has(path.extname(f.name).toLowerCase()));
}

/** 按 ID 找文件项（递归，保证 /v1/file/detail 能直接查到任意层级） */
function findItem(id) {
  const target = fromId(id);
  if (target === '/') return { id, parentId: null, name: 'root', type: 'folder', hasChild: true };
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return null;
  const st = fs.statSync(abs);
  const isDir = st.isDirectory();
  const parentRel = path.posix.dirname(target);
  return {
    id,
    parentId: parentRel === '/' ? null : toId(parentRel),
    name: path.basename(target),
    type: isDir ? 'folder' : 'file',
    hasChild: isDir && fs.readdirSync(abs).length > 0,
    updateTime: st.mtime.toISOString(),
    createTime: st.birthtime.toISOString()
  };
}

const ok = (data) => JSON.stringify({ success: true, message: '', data });
const fail = (message) => JSON.stringify({ success: false, message, data: null });

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      return res.end(fail('Unauthorized'));
    }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const route = `${req.method} ${url.pathname}`;
      const payload = body ? JSON.parse(body) : {};

      // 列目录（FastGPT 浏览/同步时调）
      if (route === 'POST /v1/file/list') {
        return res.end(ok(listDir(payload.parentId, payload.searchKey || '')));
      }

      // 文件详情（导入单个文件前先调这个拿 name/type）
      if (route === 'GET /v1/file/detail') {
        const item = findItem(url.searchParams.get('id') || '');
        if (!item) { res.statusCode = 404; return res.end(fail('File not found')); }
        return res.end(ok(item));
      }

      // 文件正文 —— FastGPT 拿它切分训练。大文件走 previewUrl 也行
      if (route === 'GET /v1/file/content') {
        const id = url.searchParams.get('id') || '';
        const item = findItem(id);
        if (!item || item.type !== 'file') { res.statusCode = 404; return res.end(fail('File not found')); }
        const text = fs.readFileSync(path.join(ROOT, fromId(id)), 'utf8');
        return res.end(ok({ title: item.name, content: text }));
      }

      // 预览地址（可选，返回原文链接即可）
      if (route === 'GET /v1/file/read') {
        const id = url.searchParams.get('id') || '';
        return res.end(ok({ url: `http://127.0.0.1:${PORT}/raw/${encodeURIComponent(id)}` }));
      }

      res.statusCode = 404;
      res.end(fail(`no route: ${route}`));
    });
  })
  .listen(PORT, () => {
    console.log(`api-dataset server: http://127.0.0.1:${PORT}  KB_DIR=${ROOT}  token=${TOKEN}`);
  });
