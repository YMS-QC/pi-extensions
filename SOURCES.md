# 源码来源（vendored packages）

本仓为私有 monorepo，不 fork 任何仓库。第三方代码以 **git subtree 收纳**（上游完整历史保留在 git log），
本仓对收纳代码的修改直接提交在本仓。同步上游：`./update-vendors.sh`。

## packages/stack/ — 收纳的第三方扩展（已打自有补丁）

| 子包 | 上游仓库 | vendor 基线 | 本仓补丁（原 fork 仓 commit，已随 subtree 并入历史） |
|---|---|---|---|
| `pi-telegram` | github.com/llblab/pi-telegram | 0.29.0 (d97f537) | `4dae784` stale-extension-ctx 崩溃修复：ctx 失效后 isIdle/cwd/model 等读取降级不抛错，session context store 自愈 |
| `pi-automode` | github.com/czottmann/pi-automode | 1.11.0 (bd82e29) | `7b3516f` 通知级别配置；`a682faf` bash 只读快路径；`78f3139` 决策 LRU 缓存；`741ae0b` 补充文档 |
| `pi-hermes-memory` | github.com/chandra447/pi-hermes-memory | 0.9.6 (911c728) | `69b3f92` PI_HERMES_* 环境变量覆盖 + /memory-reload 热切换 LLM 模型 |

同步命令：`git subtree pull --prefix=packages/stack/<子包> <上游URL> main`（update-vendors.sh 已封装）。

### 依赖管理（重要）

vendored 包**不进 root npm workspace**，各自用自带的 package-lock.json 在包目录内安装
（`npm ci`），跑各自的 typecheck/test 脚本（root 门禁里的 `stack-checks`，见
scripts/run-stack-checks.mjs）。好处：root lockfile 与上游依赖变化彻底解耦，subtree
合并后 root `npm ci` 不会失配；vendored 树永远不被本仓工具链改写。

### 自动同步（GitHub Actions）

`.github/workflows/vendor-sync.yml` 每周二 03:30 (Asia/Shanghai) 自动：fetch 上游 →
LLM 评审各包 diff（判定 adopt/hold/manual，输出报告，LLM 输出永不被执行）→ 全部
adopt 时 subtree pull + `npm run check` + push main；否则只发/更新带 `vendor-sync`
标签的 issue 等人处理。也可 Actions 页面手动触发（可跳过 LLM / 指定包）。
评审脚本：scripts/vendor-sync-llm.mjs（本地可 `node scripts/vendor-sync-llm.mjs --dry-run` 预览）。
LLM 默认走 GitHub Models（GITHUB_TOKEN 即可），可用 repo variables/secrets 覆盖
（VENDOR_SYNC_LLM_BASE_URL / VENDOR_SYNC_LLM_MODEL / VENDOR_SYNC_LLM_API_KEY）。

评审策略为**乐观并入**：默认 adopt（文本冲突交给 subtree merge，行为回归交给 check
门禁兼底），hold 仅限原则性冲突（许可证变更、上游静默废弃本地补丁且非等效实现、
可疑代码）。上游活跃度（近期 merged PR）会作为信号进入评审。本地补丁被上游等效
覆盖时报告会标注 superseded_patches，可趁机删本地补丁或按上面流程给上游提 PR。

**给上游提 PR**：需要 PR 时临时 `gh repo fork` 对应上游仓，从本仓 subtree split 导出分支推送即可，平时不维护 fork 仓。

## packages/（自有资产，原创）

| 子包 | 说明 | 部署 |
|---|---|---|
| `pi-agents` | subagents 人格定义（scout/worker/reviewer/researcher/reverser/deep-researcher） | `./deploy.sh` → ~/.pi/agent/agents/ |
| `pi-config` | sync-models.py 模型配置单一真源渲染 | 原地运行 |
| `pi-model-config` | /models 模型方案切换扩展 | `./deploy.sh` → ~/.pi/agent/extensions/model-config/ |

## 历史备注

- 本仓最初 fork 自 narumiruna/pi-extensions（2026-08），其 27 个上游包因不使用已从树中移除（历史仍在），upstream 关联已解除
- 三方包补丁原先维护在独立 fork 仓（YMS-QC/pi-telegram 等），2026-08-17 起并入本仓 vendor 模式

## memory/ — 原则/知识/记忆快照（非 vendor，自有内容）

| 文件/目录 | 本机位置 | 内容 |
|---|---|---|
| `AGENTS.md` | ~/.pi/agent/AGENTS.md | 全局行为原则（回复风格/Office/视觉MCP/识图规则） |
| `MEMORY.md` | ~/.pi/agent/pi-hermes-memory/ | 环境知识备忘（hermes 全局记忆，含手动头部块） |
| `USER.md` `failures.md` | 同上 | 用户画像 / 教训记录（hermes 格式：§ 分隔+时间标记） |
| `projects/` | ~/.pi/agent/projects-memory/ | 各项目知识（仅 .md；recovery/locks/数据库不进仓） |
| `skills/` | ~/.pi/agent/skills/ | 自定义技能（ebs-jira-review 系列、frontend-design 等） |

同步：`./sync-memory.sh pull`（日常快照进仓）/ `push`（换机恢复）。密钥扫描命中即中止。
sessions.db（会话搜索索引）为运行时数据库，不迁移，hermes 启动后自动重建。
