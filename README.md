# Catalpa 编辑预览台 · 稳定目录（TOC）服务

基于 `Vue 3 + Vite` 的 Catalpa 文本编辑/实时预览工具，并扩展了一套以**稳定节点身份**为核心的目录服务：

- 前端以稳定 id 在编辑树、预览页、虚拟目录列表之间同步光标与高亮；
- Node 后端只解析**已保存版本**并生成锚点索引；
- JSON 数据库（原子写）维护公开链接迁移与节点沿革；
- 改名/改层级身份不变；拆分、复制、同名无关章节一律新身份；
- 编辑树 / 预览 / 服务器索引版本不一致时，按**位置映射协议**显示“待刷新”，绝不乱跳；
- 导出锚点使用**冻结索引**。

## 目录结构

```text
src/
├── core/                    # 前后端同构的核心算法（无 DOM 依赖）
│   ├── parser.js            # Catalpa 结构解析（标题、显式锚点、代码块安全）
│   ├── slug.js              # 可读别名 slug 分配与冲突消解
│   ├── identity.js          # 稳定 id、指纹、相似度、内容哈希
│   ├── heading-diff.js      # 标题身份协调（改名/拆分/复制/删除恢复）
│   ├── index.js             # 锚点索引、旧链接解析、冻结导出
│   ├── position-map.js      # 编辑/预览/索引三方位置映射协议
│   ├── virtual.js           # 虚拟目录窗口 + 未加载节点点击重试
│   └── navigation-session.js# 目录会话与字体重排后的按 id 重测
├── composables/
│   └── useTocService.js     # Vue 集成：防抖 reconcile、版本号、PositionMap
├── components/
│   ├── TocTree.vue          # 目录树（状态徽标、待刷新提示、虚拟窗口）
│   └── PreviewPane.vue      # 预览渲染与重排安全的标题测量
├── utils/
│   ├── catalpa.js           # Catalpa 渲染（支持稳定标题 id）
│   └── api.js               # API 客户端
└── App.vue                  # 三栏：目录 / 编辑 / 预览
server/
├── index.js                 # HTTP 服务入口（默认 3001）
├── app.js                   # API：文档/保存CAS/链接/沿革/导出
├── db.js / serialize.js     # JSON 文件存储（tmp+rename 原子写，串行写事务）
└── data/                    # 运行时数据（gitignore）
test/                        # node:test 验收测试（29 项）
docs/design.md               # 完整设计文档（协议、不变量、算法）
```

## 快速开始

```bash
corepack pnpm install

# 仅前端
pnpm dev            # http://localhost:3000（/api 代理到 3001）

# 前端 + 后端
pnpm server         # 仅 API，http://localhost:3001
# 或两个终端分别运行 pnpm server 与 pnpm dev

# 测试（核心协议 + 服务器端到端）
pnpm test
```

## 核心不变量

1. **内部一切跳转用稳定 id**；slug 只是可读别名。别名归属永不重新分配。
2. 改名、改层级、撤销恢复：身份沿用，旧别名可跟随。
3. 拆分标题：旧身份删除并产生一组新身份，旧锚点返回 `ambiguous` 候选，不自动跳。
4. 复制章节：粘贴的同标题章节是新身份（`copiedFrom` 指向来源）。
5. 删除后又出现同名章节：仅当相邻结构证据（存活边界）吻合才恢复原 id，
   否则视为无关新章节，旧链接返回 `foreign` 而不是跳到它。
6. 版本不一致或缺映射：`index-stale` / `missing` / `deleted`，UI 显示“待刷新”。

## 锚点解析状态

| status | 含义 | 行为 |
| --- | --- | --- |
| `ok` | 当前定位 | 直接跳转 |
| `renamed` | 章节改名，身份仍唯一 | 跟随并提示 |
| `ambiguous` | 拆分等一对多 | 展示候选，不自动跳 |
| `foreign` | 同名但无关的章节占用 | 不跳，提示链接属于已删除章节 |
| `gone` | 已删除且无候选 | 显示失效 |

## HTTP API 摘要

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/docs` | 创建文档（解析首版，生成索引） |
| `GET /api/docs/:id` | 当前保存版本与索引视图 |
| `PUT /api/docs/:id` | 保存新版本，body 带 `baseRevision`；过期返回 409 |
| `GET /api/docs/:id/history` | 节点沿革（含删除）与事件 |
| `GET /api/docs/:id/resolve?anchor=` | 解析 id 或可读别名 |
| `POST/GET /api/docs/:id/links` | 公开链接及其迁移状态 |
| `GET /l/:docSlug/:linkSlug` | 公开访问（可带 `?export=`） |
| `POST /api/docs/:id/exports` | 在指定保存版本创建冻结导出 |
| `GET /p/:docSlug/:exportId?anchor=` | 冻结链接解析（永不受后续改动影响） |

## 验收场景（见 `test/`）

重复标题身份区分、删除后恢复、虚拟列表未加载节点、字体重排后按 id 重测、
跨设备同时改层级（409 + 沿革 level-change）、目录→编辑→返回预览定位同一内容、
拆分一对多歧义、复制新身份、同名无关 `foreign`、冻结导出锚点。
