// 账号（account）= 一套「实例 + 凭据 + 版本快照」的隔离 HOME 目录。
//
// 为什么要它：一个 FastGPT 工程师会同时面对多个客户实例，域名/账号/版本各异。
// 把每套凭据集中到 ~/.fastgpt/accounts/<name>/，项目目录只放一句「用哪个账号」的绑定，
// 这样：① 凭据集中管理不散落 ② 项目目录可安全进 git（绑定文件不含密钥）
//       ③ cd 进项目目录 → agent 调 CLI 自动用对应账号（cwd 自动认）
//
// 解析出的 HOME 用于 client.mjs 的配置/凭据位置。优先级（高→低）：
//   1. 命令行 --account <name>（脚本/循环多客户最显式）
//   2. 环境变量 FASTGPT_ACCOUNT
//   3. 从 cwd 向上找 <dir>/.fastgpt/account（项目绑定，git 友好）
//   4. ~/.fastgpt/active（全局默认，fastgpt account use 写入）
//   5. 无 → 用基础目录本身（向后兼容：老的 ~/.fastgpt 直接当默认账号）
//
// 基础目录 = FASTGPT_HOME || ~/.fastgpt。账号目录 = <基础目录>/accounts/<name>。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 基础目录（所有账号的父目录 + 全局默认） */
export const FG_BASE = path.resolve(process.env.FASTGPT_HOME || path.join(os.homedir(), '.fastgpt'));

/** 账号目录 */
export const accountsDir = () => path.join(FG_BASE, 'accounts');

const ACCOUNT_NAME_RE = /^[A-Za-z0-9._\-\u4e00-\u9fa5]+$/;

/** 从原始 argv 里取 --account/--account=x（在正式 parseArgs 之前也能用） */
export function accountFromArgv(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const key of ['account', 'workspace']) {
      if (a === `--${key}`) {
        const v = argv[i + 1];
        return v && !v.startsWith('-') ? v : null;
      }
      if (a.startsWith(`--${key}=`)) return a.slice(key.length + 3) || null;
    }
  }
  return null;
}

/** 从 cwd 向上逐级找 .fastgpt/account，返回 {account, root} 或 null */
export function accountFromProject(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    const f = path.join(dir, '.fastgpt', 'account');
    try {
      const name = fs.readFileSync(f, 'utf8').trim();
      if (name && ACCOUNT_NAME_RE.test(name)) return { account: name, root: dir };
    } catch { /* 没有就继续向上 */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;   // 到根了
    dir = parent;
  }
  return null;
}

/** 读全局默认账号（~/.fastgpt/active 的内容） */
export function activeAccount() {
  try {
    const name = fs.readFileSync(path.join(FG_BASE, 'active'), 'utf8').trim();
    return name && ACCOUNT_NAME_RE.test(name) ? name : null;
  } catch { return null; }
}

export function setActiveAccount(name) {
  fs.mkdirSync(FG_BASE, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(FG_BASE, 'active'), name, { mode: 0o600 });
}

export function clearActiveAccount() {
  try { fs.unlinkSync(path.join(FG_BASE, 'active')); } catch {}
}

/** 项目目录绑定账号：写 <dir>/.fastgpt/account */
export function linkProject(name, dir = process.cwd()) {
  const d = path.join(path.resolve(dir), '.fastgpt');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'account'), name, { mode: 0o644 });  // 可进 git，不含密钥
  return path.join(d, 'account');
}

export function unlinkProject(dir = process.cwd()) {
  const f = path.join(path.resolve(dir), '.fastgpt', 'account');
  try { fs.unlinkSync(f); return true; } catch { return false; }
}

/**
 * 解析当前该用哪个账号。返回 {name, source, home} 或 {name:null, source:'default', home: FG_BASE}。
 * source: 'arg' | 'env' | 'project' | 'active' | 'default'
 */
export function resolveAccount(argv) {
  let name = null, source = null;

  const fromArg = accountFromArgv(argv);
  if (fromArg) { name = fromArg; source = 'arg'; }
  else if (process.env.FASTGPT_ACCOUNT) { name = process.env.FASTGPT_ACCOUNT; source = 'env'; }
  else {
    const proj = accountFromProject();
    if (proj) { name = proj.account; source = 'project'; }
    else {
      const act = activeAccount();
      if (act) { name = act; source = 'active'; }
    }
  }

  if (!name) return { name: null, source: 'default', home: FG_BASE };
  return { name, source, home: path.join(accountsDir(), name) };
}

// 模块加载时算一次，导出的 HOME / CURRENT_ACCOUNT 供各模块复用（避免各自重复解析）。
const _resolved = resolveAccount();
/** 当前生效的配置目录（已根据 account 解析） */
export const HOME = _resolved.home;
/** 当前账号信息 {name, source}，name 为 null 表示用默认（FG_BASE）*/ 
export const CURRENT_ACCOUNT = { name: _resolved.name, source: _resolved.source };

/** 列出所有账号（扫描 accounts 目录） */
export function listAccounts() {
  const res = [];
  const dir = accountsDir();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return res; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const home = path.join(dir, e.name);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch {}
    const hasCookie = fs.existsSync(path.join(home, 'cookies.json'));
    res.push({
      name: e.name,
      base: cfg.base || null,
      version: cfg.instanceVersion || cfg.systemVersion || null,
      login: hasCookie,
      path: home,
    });
  }
  return res.sort((a, b) => a.name.localeCompare(b.name));
}

export function accountExists(name) {
  return fs.existsSync(path.join(accountsDir(), name));
}

export function assertAccountName(name) {
  if (!name || !ACCOUNT_NAME_RE.test(name)) {
    throw new Error(`账号名不合法：${name}（只能用字母/数字/._-/中文）`);
  }
  return name;
}
