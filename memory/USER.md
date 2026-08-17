用户目标是替换 Claude Code (CC)，全面迁移到 Pi coding agent。已完成 CC 记忆迁移至 pi-hermes-memory，fork/优化 pi-automode 护栏，建立统一模型配置管理。偏好：单真源配置、自动化同步、减少通知噪音、保留安全护栏（分类器+快路径）。 <!-- created=2026-08-16, last=2026-08-16 -->
§
用户偏好单一真源配置，避免多处硬编码。偏好离线启动 (`PI_OFFLINE=1`) 和静默启动 (`quietStartup: true`)。偏好 TUI 全屏模式。 <!-- created=2026-08-16, last=2026-08-16 -->
§
用户偏好单一真源配置，避免多处硬编码。使用 `~/private_repo/pi-config/sync-models.py` 同步模型配置至 settings.json/automode.json/hermes-memory-config.json。预设切换通过官方 preset.ts 插件实现 (ctrl+shift+u 或 /preset)。现已升级为私有 model-config 扩展实现全栈热切换。 <!-- created=2026-08-16, last=2026-08-16 -->
§
用户偏好离线启动 (`PI_OFFLINE=1`) 和静默启动 (`quietStartup: true`)。偏好 TUI 全屏模式。 <!-- created=2026-08-16, last=2026-08-16 -->
§
User has completed migration from Claude Code (CC) to Pi coding agent as primary environment. Key milestones: migrated CC memories to pi-hermes-memory (SQLite FTS5), forked and enhanced pi-automode (notifications/bashFastPath/decisionCache), implemented unified model management via model-config extension, and established layered subagent configuration (scout/worker/researcher/deep-researcher/reverser). Pi is now the default tool for coding tasks. <!-- created=2026-08-16, last=2026-08-16 -->
§
pi 扩展仓库架构（2026-08-17 定稿，vendor 模式）：唯一仓=YMS-QC/pi-extensions（本地 ~/private_repo/pi-extensions，private，不 fork 任何仓库，旧 fork 仓 pi-telegram/pi-automode/pi-hermes-memory/pi-stack 已验证补丁完整并入后从 GitHub 删除）。结构：packages/stack/=第三方扩展收纳区（git subtree 收纳带补丁的 pi-telegram[llblab, stale-ctx修复]、pi-automode[czottmann, 4补丁]、pi-hermes-memory[chandra447, env覆盖+热切换]），源码直载零构建；packages/=自有资产 pi-agents/pi-config/pi-model-config（deploy.sh 部署）。settings.json 唯一 git pin: git:github.com/YMS-QC/pi-extensions@main。同步上游：仓内 ./update-vendors.sh（subtree pull 上游URL）→ pi update --extensions；打补丁直接改 packages/stack/ 并提交。来源/基线/补丁清单见仓内 SOURCES.md。上游 npm 包照常 npm 装（pi-btw/pi-goal 等）。注意：auto-mode 会 hard-deny 删除 pi-automode 源码目录（rm ~/private_repo/pi-automode 需用户手动）。 <!-- created=2026-08-16, last=2026-08-17 -->
§
Monorepo 策略：pi-extensions (YMS-QC) 为单一维护仓，清理掉上游 27 个包（通过 npm 安装），仅保留自有子包（pi-agents/pi-config/pi-model-config）和补丁包（pi-telegram/pi-automode/pi-hermes-memory in packages/stack/）。补丁包通过 git subtree add 导入，保留提交历史，直接在此仓修改。pi-extensions 作为 git pin 安装源（源码直载零构建），不再依赖 fork 中转仓。 <!-- created=2026-08-17, last=2026-08-17 -->
§
目录命名惯例：使用下划线 private_repo 而非 private-repo。所有 Pi 相关维护仓放 ~/private_repo/ (pi-extensions/pi-personal 等)。 <!-- created=2026-08-17, last=2026-08-17 -->