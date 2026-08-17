**feedback_buidan_skip_test_evidence** — 补单（回填/留痕单，原始变更早已开发并测试过，本 ticket 只为留痕/迁移）在 Approval-QA 阶段的"缺 dev 测试痕迹"HIGH（留痕检查 found:false 那条）**不构成阻断**：标 WONTFIX，上线建议改放行。

**Why:** TE-1562 用户原话「这个是补单，已经测试过了」。Step 2e 的 test_evidence 检查只看本 ticket 附件/评论有无"测试"关键字，补单天然没有，但工作已在原始单测过。

**How to apply:** 仍照常出 H-01 留痕缺失项（保留审计轨迹），但状态写 WONTFIX 并注明"补单，原始变更已测试，评审人确认"；汇总表与上线建议同步改放行。submit 时决策=放行，与 review 结论一致即无需 Step 4c 澄清。仅当用户明确说是补单时才这样降级，不要自行假设。关联 [[project_md_review_skill]] 同属 ebs-jira-review 评审链路。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_design_review_stage** — 用户原话纠正：设计文档评审阶段，**需求大多还没实现**，所以文档里的截图**大部分是现状截图**，不是改造后的样张。

**How to apply**（md-review / 设计评审时）：
- 评审定位 = "要去做什么 / 设计是否完整、自洽、可据以开发"，**不是**"是否已正确实现"。
- 截图**默认当现状/示意图**：不得据此判定实现对错，**不要要求 dev 提供"改造后真实样张"**。仅当文档明确标注"已手工尝试的样例"时，截图才用于实现一致性核对。
- "现状配置截图"（如冻结日记账=否）= 当前环境；本次要改成什么属待实现/部署项，确认设计或部署步骤是否覆盖即可，**不当"配置错误"判 HIGH**。
- 疑点主轴 = **正文描述 ↔ 文档内"实现过程"SQL/规则** 是否自洽 + 需求是否被设计覆盖 + 规则/口径是否明确 + 未定项是否标注。
- HIGH 仅给：需求未覆盖 / 设计自相矛盾 / 规则缺失或歧义致无法正确开发。**不要因"截图非改造后"判 HIGH**。

**Why**：首轮我把"截图是改造前旧样张、证明不了实现"当 HIGH，是用"代码验收"口径错套到"设计评审"。批名类疑点的**真正依据是正文 vs 文档内 SQL 的矛盾**（流水号硬编码、字段顺序不一致、代理公司 002 缺失），与截图无关——这些仍成立。

关联：[[project_md_review_skill]] [[feedback_docx_images_review]]
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_diff_line_ending_crlf** — EBS Jira 附件 pkb/sql 文件常是 **LF**，而 `~/svn/xxamw/sql/` 基线是 **CRLF**。直接 `diff -u` 会把整文件每一行都判为改动，diff 行数虚高至上万行（TE-1609 三个 pkb 实际改动 61 行，原始 diff 却显示 24410 行），并误触发 `USE_SUBAGENT`（>5000 行）阈值，浪费 sub-agent 派发。

**Why**：行尾符差异不是逻辑改动，但 `diff -u` 默认逐行比对，CRLF↔LF 让全部行"变了"。`git diff`/`svn diff` 同理。

**How to apply**：评审前先 `file` 检测两端行尾；若一端 CRLF 一端 LF，改用 `diff --strip-trailing-cr -u`（归一化 CR）再生成 `diff/*.diff`，真实改动才看得清。真实改动行数 < 5000 时走直跑模式。行尾差异仅影响 `svn-commit` 阶段的 commit diff 体积（整个文件被标记改动），不影响逻辑评审结论，提交阶段无需处理。相关 [[project_migration_columns_vary]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_doc_parser** — 读 `.doc` / `.docx`（尤其是 MD070、E0、E1 这类 EBS 设计文档）时：
- 第一选择：`document-skills:docx` skill（处理 .docx）
- 第二选择：Python — `python-docx`（.docx）、`docx2txt`（.docx）、`olefile` + `antiword` 替代品（.doc 老格式）
- 第三选择：Node.js — `mammoth` 包（.docx 转 markdown 质量好）、`textract` 包（兼容旧 .doc）
- 老 `.doc`（OLE 复合文档）若没有原生工具，可以写 Python 用 `olefile` 提取 `WordDocument` stream 后做基础文本抽取

**实测：本 WSL 环境 libreoffice/soffice 对某些 .doc 会 "source file could not be loaded" 反复失败（独立 profile / 显式 infilter / 拷本地副本都无效），别耗时间在 libreoffice 上。直接用 olefile piece-table 提取法（TE-1532 的 188 页 MD070 .doc 成功提取 28 万字符）：装路径 `/home/jimmy/.ebsjr_node/node_modules/`（exceljs 同目录）；脚本逻辑——读 `WordDocument` + `0Table`/`1Table`（按 flags@0x000A 的 0x0200 位选）流 → FIB 解析 fcClx/lcbClx（fcClx 在 FibRgFcLcb97 第 33 对、ccpText 在 FibRgLw97+0x0C）→ 解 CLX 找 Pcdt(0x02) 跳过 Prc(0x01) → PlcPcd 每个 Pcd 的 fc（bit30=压缩 cp1252，否则 utf-16-le）拼文本。提取出来的 .doc 文本通常无换行（tab/field 分隔），用 `tr '\t\v\r' '\n'` 转行后再 grep。

**Why**：用户原话「doc 尝试 python 或 nodejs 解析」。之前评审 TE-1250 时遇到 `.doc` 设计文档（MD070 v2.4 / E0_CN_XXD2DITO8057A），因本机无 LibreOffice/pandoc/antiword 就直接在产物里写"未能解析"作为局限，被指出应当先尝试用脚本方式抽取。

**How to apply**：所有 EBS Jira 评审场景里碰到 `.doc` 设计文档都按上述顺序尝试，写不出"未能解析"或"评审环境局限"这种话直接放弃；至少要尝试 1-2 种脚本方案再说明结果。相关：[[fee
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_docx_images_review** — EBS MD070 设计文档（.docx）大量关键逻辑（流程图、日记账借贷分录示例、批名/命名示例、快码配置截图）以**截图**嵌入，docx 文本提取（unpack.py / python-docx）拿不到这些内容，纯文字评审会漏审。

**How to apply**：评审 docx 时一并提取图片再用 Read 逐张看。docx 即 zip，图片在内部 `word/media/`：
`unzip -o -j "附件.docx" 'word/media/*' -d "<ticket目录>/images"`
然后用 Read 工具（支持 PNG/JPG 视觉）逐张读 `images/image*.png`，把图里逻辑抽成文本与文档文字/内嵌 SQL 对照。
注意：`.emf/.wmf` 矢量图 Read 看不了，需先转 png。转换优先 `libreoffice/soffice --headless --convert-to png`，没有就 inkscape / ImageMagick(+libwmf)。本机这些**全没装**时，可用 **Python3+Pillow 直接解析 EMF 记录流（MOVETOEX/LINETO + EMR_EXTTEXTOUTW）自绘 png**，无需任何 office/转换器（TE-1514 image2.emf 已用此法成功）。中文显方块时 `apt install fonts-wqy-zenhei`，但文字/坐标已从 EMF 文本流正确还原，不影响读内容。

**Why**：TE-1512/TE-1514（O2C 海外购结汇/分账入 GL）首次评审就发现：文档文字只占一半，13/18 张图里才是流程、账务分录、批名样例——不看图无法判断设计自洽性。

关联：[[feedback_doc_parser]]
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_grep_gbk_binary** — EBS 客制 PL/SQL 附件（尤其含中文字面量的，如黑名单 `[黑名单]`）常为 **GBK/cp936** 编码。这类文件含非 UTF-8 字节，`grep`/`grep -i` 在 UTF-8 locale 下会把整个文件判为 binary 并**静默不输出匹配**（不报错），导致漏判改动行数、漏读 `TE-XXXX` 标注。

**Why**：TE-1494 评审时 `grep -in "TE-1494" XXD2DITI740A.pkb` 返回空，误判 A.pkb 无改动；实际有 20 处。换 `grep -an`（或 `LC_ALL=C grep`）才正确。

**How to apply**：
- 读 PL/SQL 附件前先 `file -i` 看编码；统计/检索一律用 `LC_ALL=C grep -an`。
- 看中文内容用 `iconv -f GBK -t UTF-8` 或 python `cp936` 解码。
- 注意 `grep -c $'\x00'` 是无效测试（bash 把 NUL 变空串→匹配所有行），别用它判 NUL。
- 关联 [[feedback_xlsx_editor]] [[feedback_doc_parser]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_oaf_jar_baseline** — 评审 OAF Java 类（`AssetTransactionAMImpl`/`*CO` 等）时，diff 基线**不能**机械用 plugin 的 `ls mds/{RICEW_PREFIX}*.jar | sort | tail -1`（字典序取同名前缀最新）。OAF java 类**按全限定类名唯一部署**，jar 只是交付载体；当多个 RICEW（如 `R2R_EXT_820_GBL` 与 `R2R_EXT_821_GBL`）**共享同一批运行时类**时，生产真实版本是「最新提交且已上线的那个 jar」，可能跨 RICEW 前缀。

**Why**：TE-1595 实例——评审 `R2R_EXT_821_GBL_TE-1595.jar` 的 `AssetTransactionAMImpl` 时，按字典序取了 `R2R_EXT_821_GBL_TE-1025.jar` 当基线，diff 出 144 行，把 `//TE-1413` 注释块（6 段 sRetVal + 三汇总字段）误判为「本 ticket 范围蔓延 + 配套 ShowAssetDetailsCO 缺失」，标了 HIGH。实际上 TE-1413 属 `R2R_EXT_820_GBL`、已 Close 上线、提交时间（2026-03-26）晚于 TE-1025（2025-07-30），其 AMImpl 已是生产真实版本；TE-1595 只是「基于该版本 + POI 升级」的正常增量。改用 TE-1413(820) 作基线后 diff 缩为 55 行、全是 POI 改动，HIGH 误判撤销。用户当场指出「包含已上线代码，HIGH 判断有问题」。

**How to apply**：
- 评审 OAF java 类第一步：先 `grep -rl 类名` 找出该类在 `~/svn/xxamw/mds/` 下出现的**所有** jar（不限同 RICEW 前缀），按 `svn log` 提交时间 + Jira 状态（已上线/Close）排序，取**最新已上线**那个作 diff 基线。
- 看到 diff 里带别的 ticket 号注释（`//TE-1413`/`//TE-1025`）且改动量大时，先怀疑基线选错，去查这些 ticket 是否已上线、其 jar 是否才是生产真实版本，而不是先判「范围蔓延」。
- 「jar 内 CO 版本 ≠ 生产 CO 版本」：CO 按全限定名唯一，820 部署的 CO 就是 821 运行时的 CO；判断配套是否缺失要看生产实际类版本，不是看本 jar 有没有带 CO。
- **同 RICEW 不同后缀也可能是不同组件**（TE-1614 实例）：`D2D_EXT_145_GBL_TE-1439.jar`（server 层 `XXNtfMsgHDRAttrVOImpl
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_pre_prod_full_review** — 判断评审范围时，**先看是否已上线 PRD**：
- **已上线 / 后续迭代**：以 SVN diff 为评审入口，只看本次改动行（增量评审）。SVN 基线代表 PRD 稳定版本。
- **首次上线 / 未到 PRD**：把整批文件（pkb / pks / vw / tbl / idx / seq / syn / xml / java 等）当做整体首次提交评审，**不限于 diff 行**。即使某些文件相对 SVN 字节一致，整体仍属未上线代码，需要逐文件审业务实现、命名、字段、约束、性能、可维护性。

判断方法：
- Jira 状态 `Approval - Dev` / 首次 `Approval - QA` / 首次 `Validation - QA` → 多半未上线
- SVN log 看 `pkb` 是否在 PRD 分支或主干 — Trident 项目 PRD 部署一般会有 r/major tag，或在 Migration 7 章节有"已上线 Date"
- Migration 表头/封面看是否已填部署日期；附件设计文档 Version History 看是否已经走过 PRD validation
- 实在不确定就问开发或反向核对 Code Inventory 中 SUBVERSION REVISION NUMBER 是否已填值（填了就是已部署到 SVN/PRD）

**Why**：用户原话「由于这个需求没有上线，可能需要对全文进行审核，而不是只是专注增量部分」。之前 TE-1250 批次 1 把 25 个与 SVN 一致的 `.idx/.seq/.syn/.tbl/.pks` 文件归为"未改动 → 无需审"，但这些代码同样还未上线，业务规则、表结构、序列起点这些 PRD 级别的问题没看 — 漏掉了首次上线该看的东西。

**How to apply**：未上线场景下，CODE_REVIEW 的"影响范围"小节要把所有文件都列入；评审产物必须覆盖：表结构（列类型/约束/索引）、序列（起点/增量/cache）、同义词指向、视图业务规则（不止字段映射，还有 JOIN 是否漏字段、过滤是否完备）、包体所有公开过程的输入校验/异常处理/事务边界，而不只是 diff 行所在的过程。相关：[[feedback-doc-parser]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_review_line_numbers** — 写 CODE_REVIEW 时，**每个 `### 编号 [级别]` 条目都必须带 `**位置**：文件 L行号`**——不分严重度、不分是否 FIXED/VERIFIED 验证项。LOW/NIT 和"已修复"验证项最容易被简写漏掉。行号取**当前附件源文件 `grep -an` 实测**，不可用 diff 的 `@@` 偏移、文字描述（"各子查询""同位置"）、或上一批次旧行号代替（再评审时行号会整体偏移）。

**Why:** 2026-06-17 TE-1551 批次2 我把验证项和新增 L-02/L-03 写成了简写、没给行号，被用户当场指出。skill 文字里本来就有"必带行号"的要求，我照样漏了——纯文字约束不可靠。

**How to apply:** 写每条 finding 前先 grep 源文件拿到真实行号再写 `**位置**` 行。review.md 已加 **Step 8c 提交前 awk 硬门槛**：扫每个 `### 编号` 条目，缺 `**位置**:L行号` 就拦住不 commit。豁免：业务完整性类"无代码可指"条目（缺交付/整块）其 `**位置**` 行需显式含"全文/缺交付/应在…"字样才放行，但**仍必须有位置行**。grep PL/SQL 用 `LC_ALL=C grep -an`（见 [[feedback_grep_gbk_binary]]）。关联 [[project_md_review_skill]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**feedback_xlsx_editor** — 回写 Migration xlsx（`*_Migration_TE-*.xlsx`）或任何会上传回 Jira / 提交给 EBS QA 的 .xlsx 时，**用 Node.js + exceljs**，不用 Python + openpyxl。

**Why：** 用户原话「python 每次都会弄坏文件」。已知 openpyxl 会在 save 时丢失/破坏样式（条件格式、合并单元格样式、ActiveX/VBA、原图表的精确尺寸/位置等）。EBS Migration 模板含较多预设样式，QA / DBA 拿到坏样式的 xlsx 会推回来。

**How to apply：**
- 任何对 ticket 目录下 .xlsx 的写回（svn-commit 的 Step 12 Migration revision 回写、submit 时给 review xlsx 附评论等场景）一律切换到 Node.js
- 推荐库：`exceljs`（保留绝大多数样式、合并、富文本、批注、图表）
- 仅读不写的场景（解析 Code Inventory / Deploy Instructions）继续用 Python pandas / openpyxl 没问题，只要不 `wb.save()` 回原文件
- 如果环境暂时没装 node/exceljs，先 `npm install exceljs`（局部安装到 /tmp 或 ~/）再用；不要为了图省事退回 openpyxl
<!-- created=2026-08-16, last=2026-08-16 -->
§
**project_datafix_goes_datamod** — SVN（`Trident/xxamw/`）里 **data fix / 一次性 DML 脚本固定放 `datamod/`**，不放 `sql/`。

实测依据（TE-1557 svn-commit 时核查）：`datamod/` 有 537 个文件，全是 data fix，含大量 `Data_fix_Script_*_TE-XXXX.sql` 命名；`sql/`（790 文件）历史上从无 data fix 脚本，只放 PL/SQL 对象（.pkb/.pks/.vw/.tbl 等）。

**Why:** TE-1557 的 Migration F 列（SUBVERSION FILE）把 2 个 data fix 脚本写成 `Trident/xxamw/sql/...`，是开发者填错路径。svn-commit 一切以 Migration E/F 列为准，若不核查会把脚本提交到错目录（不可逆）。

**How to apply:** svn-commit / review 时，凡 `Data_fix*` / 一次性 DML 脚本的 Migration 路径若指向 `sql/`，先比对 `datamod/` 是否有同类命名惯例，几乎可判定应改为 `datamod/`。提交前修正：撤回 sql/ 拷贝 → 改放 datamod/ → svn add → 同步改 Migration F 列 → 提交。`.wft` 进 `workflow/`、PL/SQL 进 `sql/` 不受影响。关联 [[project_migration_columns_vary]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**project_md_review_skill** — 新建命令 `/ebs-jira-review:md-review TE-XXXX`，评审"设计文档型"ticket（交付物是 MD070 .docx 而非源码），不碰 SVN/代码，与 `/ebs-jira-review:review`（代码评审）互补。

设计决策（2026-05-29 与用户确认）：并入 ebs-jira-review 插件复用下载/凭据/preflight；预检放宽**只校 project**（不强制 assignee=我、status∈三态，因设计评审常在早期阶段）；产**两份**产物 `design.md`(业务规格基线) + `设计评审_{TICKET}.md`(覆盖表+HIGH/MEDIUM疑点+Open items+上线建议)。

新增文件（plugin 根 `~/.claude/plugins/marketplaces/jimmy-local/plugins/ebs-jira-review/`）：
- `commands/md-review.md` — 命令主体（下载→docx提文字→提图→读图→出 design.md + 设计评审）
- `lib/extract_doc_images.sh` — 解压 docx 的 `word/media/` 到 `images/`，.emf/.wmf 走兜底转换链
- `lib/emf2png.py` — 无 libreoffice/inkscape/imagemagick 时用 Python+Pillow 解析 EMF 自绘 png（由验证过的临时脚本通用化）

下载注意：bulk `secure/attachmentzip/{id}.zip` 可能返回空，改用单附件端点 `rest/api/3/attachment/content/{attId}`。
新命令可能需重载插件/重启 Claude Code 才在 `/` 列表出现。

与 code-review 的协同改造（2026-05-29）：
- git 初始化抽成共享函数 `lib/jira_helpers.sh::ebsjr_git_init_ticket <dir>`（幂等，忽略 images/ extracted/ 及二进制，只追踪 design.md/CODE_REVIEW_*/设计评审_*/jira_issue.md/diff）。review.md 与 md-review.md 都调用它——哪个 skill 先跑就先初始化，另一个跳过。
- review.md Step 7 改为：若 design.md 已由 md-review 生成（业务规格），**不覆盖**，而是末尾**追加「代码实现对照(SVN diff)」表**；Step 8 业务完整性层**优先以 design.md 业务规格为对照基线**做需求↔实现映射。即
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**project_migration_columns_vary** — Migration xlsx 的 `1. Code Inventory` sheet 列位置**不固定**。svn-commit 文档契约假设 A=RICE/B=FILE NAME/C=TYPE/D=REV/E=PATH，但实测有变体多一个前置 `Seq #` 列，整体右移一列。

TE-1557 实测：`A=Seq# | B=RICE COMPONENT | C=FILE NAME | D=TYPE | E=SUBVERSION REVISION NUMBER | F=SUBVERSION FILE`。按硬编码列号解析得 0 行（B 列读到 RICE COMPONENT、E 列读到 PATH 而非整数）。

**Why:** 硬编码 openpyxl `row[1]/row[3]/row[4]` 或 exceljs `getCell(4)` 会静默读错列——解析 0 行（中止）或回写错列（弄坏 Migration）。

**How to apply:** 解析与回写都先读第 1 行表头，按列名 `FILE NAME` / `SUBVERSION REVISION NUMBER` / `SUBVERSION FILE` 定位列号，再取/写。TE-1557 回写 revision 是 E 列(col5) 不是契约说的 D 列(col4)。关联 [[feedback_xlsx_editor]]、[[project_datafix_goes_datamod]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**project_plsql_pitfalls_checklist** — ebs-jira-review plugin 内维护静态 PL/SQL 高危模式清单：
`~/.claude/plugins/marketplaces/jimmy-local/plugins/ebs-jira-review/reference/plsql-pitfalls.md`

**Why**：TE-1494 批次 2 发现 `LOG('msg:', varchar_value)` 参数错位（第二形参是 NUMBER）——编译期不报错、快码维护后必然 ORA-06502 被 WHEN OTHERS 吞掉、接口空跑且并发 Normal。这类坑靠"通用直觉"会漏，需要清单化强制核对。

**How to apply**：
- 跑 /ebs-jira-review:review 时评审维度 b 按清单 A-H 八类逐类核对；重点：每个新增/修改的过程调用对照被调签名逐参核对
- 评审中发现清单外的新坑 → 当场追加到 plsql-pitfalls.md 并标注来源 ticket
- 清单蒸馏来源（定期增补）：Trivadis PL/SQL & SQL Coding Guidelines（GitHub）、Steven Feuerstein 博客、Oracle-Base、Oracle Dev Gym

相关：[[feedback_grep_gbk_binary]]
<!-- created=2026-08-16, last=2026-08-16 -->
