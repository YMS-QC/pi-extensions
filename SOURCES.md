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
