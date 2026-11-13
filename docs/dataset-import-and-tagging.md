# FastGPT 文件导入与标签流程

适用于将本地多层目录中的文件导入一个或多个知识库，并根据 Excel、CSV 或 JSON 清单给每篇文档设置标签。单库场景可直接传目标库 ID；多库场景可使用逐行 `datasetId` 或目录路由。完整导入由 `ds import-tagged` 执行。

## 1. 准备导入清单

标签表按每个文件一行整理，至少包含路径列和标签列。目标知识库可在表格中逐行填写；单库导入时推荐直接通过 CLI 参数指定；多库导入时可用目录路由 JSON：

| path | datasetId（可选） | 文档分类 | 适用部门 |
| --- | --- | --- | --- |
| `2026/2026-案例库/文件.pdf` | `datasetIdA` | 案例 | 法务;财务 |
| `2026/2026-方法库/标准.docx` | `datasetIdB` | 方法 | 运营 |

通常 `path` 是相对于资料根目录的路径，区分目录层级，且资料目录内每个可见文件都要在清单中恰好出现一次。单库模式会根据本地目录和清单路径自动匹配；只有自动匹配有歧义或目录结构不对应时，才需要 `--manifest-prefix` 显式指定目录前缀。匹配使用完整相对路径，不会只按文件名猜测，以免重名资料误配。`.xlsx`/`.xlsm` 默认读第一个工作表，CSV 使用 UTF-8；表格列名默认 `path`，也会自动识别唯一的“文件路径”“文件相对路径”“相对路径”等常见表头。`序号`、`编号`、`序列号`、`No.`、`No`、`index` 默认视为非标签列；其他说明列可用 `--ignore-columns "备注,来源"` 忽略。JSON 支持每行 `{ "path", "datasetId", "tags": {...} }`。多值 array 标签可填 `法务;财务` 或 JSON 数组。

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

### 单个知识库

指定一个目标知识库 ID。CLI 会递归扫描本地资料目录，并按完整相对路径从标签总表中自动选出对应文件记录，不需要准备 `routes.json` 或手动填写 `--manifest-prefix`。自动匹配必须唯一；若文件同名、路径重复或目录名无法与清单对应，命令会在上传前报错。

```bash
# 先预检，不上传文件或写标签
node bin/fastgpt.mjs ds import-tagged ./2026-案例库 \
  --manifest ./标签总表.xlsx \
  --dataset-id "$DATASET_ID" \
  --dry-run

# 确认预检输出后执行
node bin/fastgpt.mjs ds import-tagged ./2026-案例库 \
  --manifest ./标签总表.xlsx \
  --dataset-id "$DATASET_ID" \
  --create-missing-tags
```

若标签表中也包含 `datasetId` 列，CLI 会校验它与 `--dataset-id` 一致；不一致时在上传前停止。

### 多个知识库

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

命令会递归扫描目录、按相对路径匹配标签表、预检目标库和标签维度，然后逐文件上传、打标签并回读核验。`--path-column`、`--dataset-column`、`--sheet` 可适配不同表头和工作表；不使用知识库列时加 `--dataset-column none`。默认情况下，清单中尚未在目标库建立的标签维度会阻止执行。

如需自动建立缺少的标签维度，显式加入 `--create-missing-tags`。正式执行时 CLI 会先集中创建缺少的维度、重新读取标签定义，确认成功后才上传文件；默认类型为 `string`，不会修改已存在标签的类型。`--dry-run --create-missing-tags` 只列出 `missingTags`，不会调用创建接口。需要 `array`、`number` 或 `datetime` 时显式传入类型映射，例如：

```bash
node bin/fastgpt.mjs ds import-tagged ./资料 \
  --manifest ./标签.xlsx --routes ./routes.json \
  --create-missing-tags \
  --tag-types '{"能力主题":"array","交付形式":"array"}' \
  --dry-run
```

隐藏文件不导入；清单以外的可见文件、缺失文件、重复路径、标签创建失败都会在上传前阻止执行。

如果自动推断无法唯一确定清单里的子目录，可用 `--manifest-prefix` 手动指定。通常单库场景不需要它。例如资料根目录为 `./2026-方法库`，Excel 中对应路径为 `2026年杂志分类/2026-方法库/文章.pdf`：

```bash
node bin/fastgpt.mjs ds import-tagged ./2026-方法库 \
  --manifest ./标签总表.xlsx --routes ./routes.json \
  --manifest-prefix "2026年杂志分类/2026-方法库" --dry-run
```

路由仍按清单中的原始目录路径匹配，因此 `routes.json` 需要包含 `2026-方法库` 或其上级/完整相对目录对应的知识库 ID。`--manifest-prefix` 只处理前缀下的清单行；资料目录中未出现在这些行里的可见文件仍会使预检失败。

每成功上传一篇就把 `collectionId` 和状态写入状态文件。CLI 默认按资料目录和目标知识库自动选择隐藏状态文件，不需要在命令中传 `--state`；同一目标重跑会续用对应状态，改换目标则使用独立状态，避免不同知识库的任务互相冲突。请保留自动生成的状态文件以便安全续跑。若某个任务最初使用了自定义 `--state`，续跑时仍需传同一个路径。命令会在资料根目录锁定 `.fastgpt-import.lock`，即使自定义状态文件也阻止同一目录并发导入；强制结束进程后若留下锁文件，确认没有其他导入进程运行后再删除。标签写入失败时，重跑只会补写标签，不会重传已有文档；已标记完成的文档也会重新从 FastGPT 回读标签，发现不一致会补写。若上传期间连接中断，无法确认服务端是否已创建文档，命令会暂停并要求先检查 FastGPT；确认没有创建后，才针对该文件传 `--retry-uncertain <相对路径>`，且不要改动该文件或目标知识库映射。

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
