**frontend-goal** — BTP 前端目标的单一真相源是 `web/GOAL.md`。北极星：可独立运行、假数据驱动的「预算控制台」MVP，
覆盖 查预算→发起预占→看流水 闭环 + API 运维台(含后端安全下线 drain)。

**关键约定**：前端现在只能 mock，但 mock 必须按"将来怎么跟后端交互"设计——所有数据走
`web/apps/core/src/api/modules/*` 适配层，请求/响应严格对齐 `db/pkg/xxbtp_engine.pks` 的 JSON 契约，
切真实接口时只改适配层、不动页面。

**How to apply**：要推进前端就用 `/goal` 命令（定义在 `.claude/commands/goal.md`），它会读 GOAL.md、
找下一个未完成里程碑、按验收标准实现、用 agent-browser 验证、回写勾选。里程碑：M0(脚手架+样张,已完成)
→ M1(vxe预算控制行大表) → M2(预占闭环) → M3(流水/单据) → M4(API运维台+安全下线) → M5(接真后端)。

前端底座：`web/` 基于自购 fantastic-admin pro 的 core 裁剪而来，已去除原品牌痕迹（包名 `@btp/*`、
Oracle 蓝主题 `packages/themes/index.ts`、Inter+MiSans 字体）。从 pro 搬了 9 个 `fa-*` 代码生成 skill
到 `web/.claude/skills/`（CRUD/表单/路由/store/i18n/主题等）。
<!-- created=2026-08-16, last=2026-08-16 -->
