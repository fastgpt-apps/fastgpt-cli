# FastGPT 文件导入与标签流程

适用于将本地多层目录中的文件，按目录映射导入一个或多个知识库，并根据 Excel、CSV 或 JSON 清单给每篇文档设置标签。完整导入由 `ds import-tagged` 执行。

## 1. 准备导入清单

标签表按每个文件一行整理，至少包含相对路径列和标签列。目标知识库可在表格中逐行填写，也可通过目录路由 JSON 配置：

| path | datasetId（可选） | 文档分类 | 适用部门 |
| --- | --- | --- | --- |
| `2026/2026-案例库/文件.pdf` | `datasetIdA` | 案例 | 法务;财务 |
| `2026/2026-方法库/标准.docx` | `datasetIdB` | 方法 | 运营 |

`path` 必须是相对于资料根目录的路径，区分目录层级，且每个可见文件都要在清单中恰好出现一次。`.xlsx`/`.xlsm` 默认读第一个工作表，CSV 使用 UTF-8；JSON 支持每行 `{ "path", "datasetId", "tags": {...} }`。多值 array 标签可填 `法务;财务` 或 JSON 数组。

## 2. 登录并确认知识库

使用独立配置，避免覆盖其他 FastGPT 实例的登录信息：

```bash
export FASTGPT_HOME=/tmp/fastgpt-import-session
export FASTGPT_BASE=https://fastgpt.example.com
node bin/fastgpt.mjs auth login
node bin/fastgpt.mjs auth whoami
node bin/fastgpt.mjs ds list --brief
```

`auth login` 会交互式引导选择账号密码或扫码登录。

确认登录账号、实例地址和目标知识库 ID 无误。文档标签需要商业版标签接口可用，可运行 `ds tag list <datasetId>` 检查。

## 3. 建立标签维度

每个目标库先查看已有标签，只创建缺少的维度，并确保类型与清单一致：

```bash
DATASET_ID="填入目标知识库ID"
TAG_NAME="填入标签名"
TAG_TYPE="string" # 多值标签使用 array
node bin/fastgpt.mjs ds tag list "$DATASET_ID"
node bin/fastgpt.mjs ds tag create "$DATASET_ID" --tag "$TAG_NAME" --type "$TAG_TYPE"
```

多值标签使用 `--type array`。常见类型为 `string`、`number`、`datetime`、`array`。

## 4. 一条命令导入文件并写标签

不想在标签表逐行写 `datasetId` 时，创建 `routes.json`，键可为任意目录名或相对目录路径，值是对应知识库 ID。相同目录名只能路由到同一个知识库；若规则产生冲突，命令会在上传前报错。

```bash
cat > routes.json <<'EOF'
{
  "2026-案例库": "填入案例库ID",
  "2026-方法库": "填入方法库ID",
  "2025-案例库": "填入案例库ID",
  "2025-方法库": "填入方法库ID"
}
EOF

# 先预检，不写入 FastGPT
node bin/fastgpt.mjs ds import-tagged ./资料 \
  --manifest ./标签.xlsx --routes ./routes.json --dry-run

# 确认预检输出后执行
node bin/fastgpt.mjs ds import-tagged ./资料 \
  --manifest ./标签.xlsx --routes ./routes.json
```

命令会递归扫描目录、按相对路径匹配标签表、预检目标库和标签维度，然后逐文件上传、打标签并回读核验。`--path-column`、`--dataset-column`、`--sheet` 可适配不同表头和工作表；不使用知识库列时加 `--dataset-column none`。隐藏文件不导入；清单以外的可见文件、缺失文件、重复路径、未建标签维度都会在写入前阻止执行。

每成功上传一篇就把 `collectionId` 和状态写入状态文件，默认在资料目录中生成 `.fastgpt-import-state.json`，请保留此文件以便安全续跑。命令会在资料根目录锁定 `.fastgpt-import.lock`，即使自定义状态文件也阻止同一目录并发导入；强制结束进程后若留下锁文件，确认没有其他导入进程运行后再删除。标签写入失败时，重跑只会补写标签，不会重传已有文档；已标记完成的文档也会重新从 FastGPT 回读标签，发现不一致会补写。若上传期间连接中断，无法确认服务端是否已创建文档，命令会暂停并要求先检查 FastGPT；确认没有创建后，才针对该文件传 `--retry-uncertain <相对路径>`，且不要改动该文件或目标知识库映射。

若表头不是默认名称，可这样指定：

```bash
node bin/fastgpt.mjs ds import-tagged ./资料 \
  --manifest ./标签.xlsx --routes ./routes.json \
  --path-column 文件相对路径 --dataset-column 目标知识库 \
  --sheet 标签 --dry-run
```

## 5. 单独写标签（可选）

少量文档可用 CLI：

```bash
DATASET_ID="填入目标知识库ID"
COLLECTION_ID="填入上传成功返回的文档ID"
node bin/fastgpt.mjs ds tag set "$DATASET_ID" "$COLLECTION_ID" --pairs '分类=值,密级=内部'
```

一般不需要手工运行独立打标签脚本；第 4 节命令会自动使用上传返回的 `collectionId`。已有文档若只需更新标签，可使用 CLI 的 `ds tag set` / `ds tag batch`，或者用下面按 `collectionId` 准备 JSON 清单的独立脚本：

```js
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { client } from './lib/client.mjs';

const input = process.argv[2] || 'tag-manifest.json';
const records = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!Array.isArray(records)) throw new Error('清单必须是 JSON 数组');

const schemas = new Map();
async function getSchema(datasetId) {
  if (!schemas.has(datasetId)) {
    const result = await client.get(
      `/api/proApi/core/dataset/tag/getAllTags?datasetId=${encodeURIComponent(datasetId)}`
    );
    schemas.set(datasetId, new Map((result.list || []).map(t => [t.tag, t])));
  }
  return schemas.get(datasetId);
}

async function isVerified(record) {
  const result = await client.get(
    `/api/core/dataset/collection/detail?id=${encodeURIComponent(record.collectionId)}`
  );
  const stored = (result?.collection || result)?.tags || [];
  return Object.entries(record.tags).every(([name, value]) => {
    const tag = stored.find(t => t.tag === name);
    return tag && isDeepStrictEqual(tag.value, value);
  });
}

const failed = [];
let verified = 0;
for (const record of records) {
  try {
    if (!record.datasetId || !record.collectionId ||
        !record.tags || typeof record.tags !== 'object' ||
        Array.isArray(record.tags) || Object.keys(record.tags).length === 0) {
      throw new Error('缺少 datasetId、collectionId 或 tags');
    }
    const schema = await getSchema(record.datasetId);
    const tags = Object.entries(record.tags).map(([name, value]) => {
      const definition = schema.get(name);
      if (!definition) throw new Error(`知识库中不存在标签：${name}`);
      if (definition.tagType === 'array' && !Array.isArray(value)) {
        throw new Error(`标签「${name}」需要数组值`);
      }
      return { tagId: definition._id, value };
    });

    let done = false;
    let lastError = '';
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        // 支持续跑：已正确写入的记录直接跳过。
        if (await isVerified(record)) {
          done = true;
          break;
        }
        await client.post('/api/proApi/core/dataset/tag/batchSetCollectionTags', {
          datasetId: record.datasetId,
          collectionIds: [record.collectionId],
          mode: 'add',
          tags
        });
        done = await isVerified(record);
        if (!done) lastError = '写入后回读的标签值不匹配';
      } catch (error) {
        lastError = error.message;
      }
      if (!done && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
    if (!done) throw new Error(lastError || '标签核验失败');
    verified++;
  } catch (error) {
    failed.push({ collectionId: record.collectionId, error: error.message });
    console.error(`失败 ${record.collectionId || '(无ID)'}: ${error.message}`);
  }
}

console.log(JSON.stringify({ total: records.length, verified, failed: failed.length, failures: failed }, null, 2));
if (failed.length) process.exitCode = 1;
```

清单 `tag-manifest.json` 每行对应一个已存在文档。多值标签写成 JSON 数组：

```json
[
  {
    "datasetId": "目标知识库ID",
    "collectionId": "上传返回的文档ID",
    "tags": {
      "分类": "案例",
      "适用部门": ["法务", "财务"]
    }
  }
]
```

在已登录且配置好 `FASTGPT_HOME`、`FASTGPT_BASE` 的终端执行：

```bash
node batch-tag.mjs tag-manifest.json
```

该独立脚本只负责给已存在文档打标。新文件的完整批量导入请使用 `ds import-tagged`。

## 6. 完成检查与收尾

- 对账清单数、上传成功数和知识库文档数，逐篇确认标签已核验。
- 用 `ds training <collectionId>` 检查训练状态；排队中的文档还不能视为可检索。
- 重分类时先上传并核验目标库副本。只有获得明确授权后，才按核对过的旧 `collectionId` 删除源库副本。
- 完成后注销登录态：

```bash
node bin/fastgpt.mjs auth logout
```

不要把密码、Cookie 或 API Key 写进清单、脚本、日志或文档。
