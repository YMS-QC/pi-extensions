# Fork 说明（YMS-QC 私有子包与维护流程）

本仓库是 [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) 的 fork。
上游的 27 个扩展包保持原样（见 packages/），我们自己的私有子包挂在 packages/ 下，
与上游同构，方便统一管理。

## 我们的子包

| 子包 | 内容 | 部署方式 |
|---|---|---|
| `packages/pi-agents` | subagents 人格定义（scout/worker/reviewer/researcher/reverser/deep-researcher） | `./deploy.sh` 拷贝到 `~/.pi/agent/agents/` |
| `packages/pi-config` | `sync-models.py` 模型配置单一真源渲染脚本（my-models.json → settings/automode/hermes） | 原地运行，不部署 |
| `packages/pi-model-config` | `/models` 模型方案切换扩展（profile + override） | `./deploy.sh` 拷贝到 `~/.pi/agent/extensions/model-config/` |

历史说明：三个子包由本地 git 仓库经 `git subtree add` 并入，原始提交历史保留在 git log 中。

## 部署

```bash
./deploy.sh   # 同步 agents 与 model-config 扩展到 ~/.pi/agent/
```

## 同步上游

```bash
~/private_repo/update-forks.sh   # 更新所有带 upstream 远端的 fork（含本仓库与 pi-telegram）
```

流程：fetch upstream → merge upstream/main → 无冲突则 push origin。
有冲突时中止合并并提示手工处理，不影响其他仓库。

## 加载策略

**上游扩展包一律从 npm 安装，不从本 monorepo 加载**（如 `pi install npm:@narumitw/pi-btw`）。

原因：monorepo 内 `@narumitw/pi-tui-kit` 等是 workspace 源码链接，`dist/` 只在 npm 发布时构建；
git clone + npm install 不会构建，加载时会报 `No "exports" main defined ... pi-tui-kit/package.json`。
npm 发布版自带构建产物，免维护。

若将来要给上游包打补丁并从 git 加载：在 packages/<pkg> 补丁后还需在
packages/pi-tui-kit 等被依赖包里 `npm run build` 生成 dist，且 `pi update --extensions`
重置 clone 后需重建——除非必要，默认不走这条路。

我们的子包（pi-agents / pi-model-config）不经 pi 包机制加载，由 deploy.sh 部署；
本 monorepo 不需要出现在 settings.json 的 packages 里。

## 不并入本 monorepo 的仓（保持独立的原因）

- `pi-telegram`：llblab 的 fork，需保留对上游的 fork 关系（补丁分支 fix/stale-extension-ctx）
- `pi-automode` / `pi-hermes-memory` / `pi-personal`：自有独立仓，已被 settings.json git pin 引用
