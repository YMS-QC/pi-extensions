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

上游子包不整包安装：在 `~/.pi/agent/settings.json` 里用对象形式按需过滤加载，
例如只装 pi-btw：

```json
{
  "packages": [
    {
      "source": "git:github.com/YMS-QC/pi-extensions@main",
      "extensions": ["packages/pi-btw/src/index.ts"]
    }
  ]
}
```

改动上游包（如给 pi-btw 打补丁）直接在对应 packages/<name>/ 下提交，
update-forks.sh 的 merge 不会覆盖我们独有的子包路径。

## 不并入本 monorepo 的仓（保持独立的原因）

- `pi-telegram`：llblab 的 fork，需保留对上游的 fork 关系（补丁分支 fix/stale-extension-ctx）
- `pi-automode` / `pi-hermes-memory` / `pi-personal`：自有独立仓，已被 settings.json git pin 引用
