**feedback_backup_naming** — 备份源文件（如 .pkb / .sql）时用格式 `<file>.bak_NN_MMDD_HHMM_<desc>`：

- **NN**：两位序号（01, 02, ..., 12），按时间顺序递增
- **MMDD_HHMM**：短时间戳（月日_时分），便于与文件 mtime 对照
- **desc**：简短描述这一版的语义锚点（如 `preHardening` / `preDataSplit` / `preToClobFix`）

示例：`xx_ele_dm3_archi_apcoe_pkg.pkb.bak_13_0424_1850_preDataSplit`

**Why**: 用户明确要求备份列表"有序号可以明显看出顺序 + 带日期的短时间戳"。原格式（如 `bak_preB3` / `bak_preC1`）无法一眼判断先后，他手动对照 mtime 才能知道哪个更新。

**How to apply**:
- 新建备份 → 直接用新格式，不要再用裸 `bak_<desc>`
- 接手已有 `bak_<desc>` 格式的项目 → 主动提议按 mtime 顺序批量重命名（ls -la --time-style=long-iso 确认顺序后用 mv）
- 推荐最近备份时按序号倒序列（NN 最大 = 最近）
- 序号跨项目独立（每个源文件自己一套 NN）
<!-- created=2026-08-16, last=2026-08-16 -->
§
**project_apcoe_archive_optimization** — ## 项目本体
对 Oracle PL/SQL 包 `xx_ele_archiving_apcoe_pkg`（Amway E-Archiving apcoe 归档程序）做性能优化。源文件 `xx_ele_dm3_archi_apcoe_pkg.pkb` 在 `/mnt/c/amway_repo/plsql/analysis/apcoe/`。从 QA 基线 5608 行演进到当前 ~7400 行。

## 路径与关键文件
- 工作目录：`/mnt/c/amway_repo/plsql/analysis/apcoe/`
- 当前 HEAD：`xx_ele_dm3_archi_apcoe_pkg.pkb`
- QA 基线（远程）：`/mnt/c/amway_repo/plsql/db_source/qa/APPS/PACKAGE_BODY/XX_ELE_ARCHIVING_APCOE_PKG.sql`
- **QA 基线（本地参考副本）**：`qa_baseline_XX_ELE_ARCHIVING_APCOE_PKG.pkb`（body）+ `.pls`（spec）—— 在工作目录里直接对照原逻辑用，不要修改它
- 演进时间线：`EVOLUTION.md`（A→H 阶段的完整快照对账）
- 业务差异审计：`DIFF_REPORT.md`（QA vs dm3 逐函数 diff）
- 计划文档：`STAGE_B_PLAN.md`、`ADJ_TOKENIZE_PLAN.md`

## 阶段演进（简版）
- **A**：prefetch GTT 框架 + 日志 + same_name_exist ANALYTIC
- **B.1-B.7**：INSERT...SELECT 替代 per-rec_d LOOP、view 绕过、regex→BETWEEN、ADJ tokenize
- **C.1**：same_name_exist bug fix + LOB 泄漏修复 + dead var 清理
- **C.2 split**：`insert_apcoe_ftp` 物理拆成 single + batch 双 proc
- **C.3**：注释 `update_att_text`（无消费者）
- **D**：`get_att_text` 集合化预聚合到 `xx_ele_att_text_gtt`
- **E**：single 路径 XLA 短路
- **F**：`writeappend_clob` helper 防 `utl_raw.cast_to_raw(CLOB)` 溢出
- **G**：`TO_CLOB` 包首字面量 + writeappend_clob 提升到包级（4 proc 统一）
- **H**（当前）：ORA-06502 防御治理（22 处 dm3-H 标记：
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
