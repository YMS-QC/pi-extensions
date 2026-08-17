---
name: ebs-jira-review-md-review
description: >-
  评审 Jira ticket 的设计文档(MD070/.docx)：提取文字+内嵌截图(emf兜底转png)→读图理解→产出 design.md(业务规格) 与 设计评审_{TICKET}.md。不碰 SVN/代码。用法：/skill:ebs-jira-review-md-review TE-XXXX [v2]。触发词：设计文档评审、MD070、md review。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: md-review.md
---

> **pi 迁移版**（upstream: `md-review.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
对"设计文档型"Jira ticket（交付物是 MD070 设计文档 .docx，而非源码）做**设计评审**：
1. 下载附件，识别设计文档（.docx/.doc）
2. 提取文字（python zipfile/XML 解析 docx，或 libreoffice headless 转 txt 兜底）+ **解压内嵌截图**（流程图/账务分录/批名/快码截图），`.emf/.wmf` 兜底转 png
3. 用 Read 逐张读图，把图里逻辑并入对设计的理解
4. 产出 `design.md`（从文档抽的业务规格，作为后续代码审核的对照基线）
5. 产出 `设计评审_{TICKET}.md`（需求↔设计覆盖表 + HIGH/MEDIUM 疑点 + Open items + 上线建议）

与 `/skill:ebs-jira-review-review`（代码评审，SVN diff 驱动）互补：md-review 只看设计文档、不碰 SVN/源码。两者可对同一 ticket 先后使用——先 md-review 出业务规格，review 再据此核代码。
</objective>

<domain_context>
Oracle EBS R12.2 定制开发。MD070 设计文档是 .docx，**大量关键逻辑以截图嵌入**（流程图、日记账借贷分录示例、批名/命名规则、快码/弹性域配置截图）；纯文本提取拿不到图里内容，必须解压 `word/media/` 并用 Read 看图。文档里常含"实现过程"SQL 片段（非完整源码），是接近代码的唯一线索。
</domain_context>

<config>
复用 `~/.ebs_jira_review.conf`（JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN）与 `lib/jira_helpers.sh`。
</config>

<process>

## Step 1 - 解析参数 + 目标目录

```bash
PLUGIN_LIB="$HOME/.pi/agent/ebs-jira-review/lib"
source "$PLUGIN_LIB/jira_helpers.sh"
source ~/.ebs_jira_review.conf 2>/dev/null

TICKET_ID=$(extract_ticket_id "$@") || { echo "✗ 未找到 ticket key（如 TE-1512）"; exit 1; }
VERSION_SUFFIX=$(printf '%s\n' "$@" | grep -vxE "$TICKET_ID" | head -1)

JIRA_WORK_DIR="${JIRA_WORK_DIR:-/mnt/c/Jira}"
TICKET_BASE="${TICKET_BASE:-$JIRA_WORK_DIR/ticket}"
TARGET_DIR="${TICKET_BASE}/${TICKET_ID}"
[ -n "$VERSION_SUFFIX" ] && TARGET_DIR="${TARGET_DIR}_${VERSION_SUFFIX}"
mkdir -p "$TARGET_DIR"
echo "→ TICKET=$TICKET_ID  目标目录=$TARGET_DIR"
```

## Step 2 - 预检（放宽：只校 project）

设计评审常在需求/早期阶段，**不强制 assignee=我、不强制 status∈三态**。只做 project 校验（避免误评审别的项目）。

```bash
STATE=$(jira_state "$TICKET_ID")
PROJ=$(echo "$STATE" | jq -r '.fields.project.key // empty')
SUMMARY=$(echo "$STATE" | jq -r '.fields.summary // empty')
if [ -n "${JIRA_PROJECT_KEY:-}" ] && [ -n "$PROJ" ] && [ "$PROJ" != "$JIRA_PROJECT_KEY" ]; then
  echo "✗ $TICKET_ID 属于 project '$PROJ'，本 plugin 限定 '$JIRA_PROJECT_KEY'"; exit 1
fi
echo "→ 预检通过：$TICKET_ID（project=$PROJ）—— $SUMMARY"
```

## Step 3 - 下载附件 + 保存需求/评论

> 注意：批量端点 `secure/attachmentzip/{id}.zip` 在部分 ticket 返回空 zip，**以单附件端点为准**：`rest/api/3/attachment/content/{attId}`。

```bash
ISSUE=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID?fields=summary,status,reporter,assignee,description,comment,attachment,created,updated")

# 需求 + 评论 → jira_issue.md（评审依据）
echo "$ISSUE" | jq -r '
"# " + (.fields.summary // "") + "\n\n**Ticket**：" + .key
+ "\n**状态**：" + (.fields.status.name // "")
+ "\n**报告人**：" + (.fields.reporter.displayName // "未知")
+ "\n\n## 说明\n\n" + (.fields.description // "（无）" | if type=="object" then tostring else . end)
+ "\n\n## 评论（" + ((.fields.comment.comments // [])|length|tostring) + "）\n\n"
+ ((.fields.comment.comments // []) | sort_by(.created)
   | map("### " + (.author.displayName//"?") + " — " + (.created//"") + "\n\n"
         + (.body // "" | if type=="object" then tostring else . end)) | join("\n\n---\n\n"))
' > "$TARGET_DIR/jira_issue.md"

# 逐个下载附件（单附件端点）
echo "$ISSUE" | jq -r '.fields.attachment[]? | "\(.id)\t\(.filename)"' | while IFS=$'\t' read -r AID FN; do
  [ -z "$AID" ] && continue
  curl -s -L -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    -o "$TARGET_DIR/$FN" \
    "$JIRA_BASE_URL/rest/api/3/attachment/content/$AID"
  echo "  下载：$FN"
done
```

附件数为 0 → 停止。

## Step 4 - 识别设计文档 + 提取图片

```bash
# 找设计文档（.docx 优先；.doc 需先转 docx）
DOC=$(find "$TARGET_DIR" -maxdepth 1 -type f \( -iname '*.docx' -o -iname '*.doc' \) | head -1)
[ -z "$DOC" ] && { echo "✗ 未找到 .docx/.doc 设计文档"; exit 1; }
echo "→ 设计文档：$(basename "$DOC")"

# 提取内嵌图片到 images/（.emf/.wmf 兜底转 png）
bash "$PLUGIN_LIB/extract_doc_images.sh" "$DOC" "$TARGET_DIR/images"
```

## Step 5 - 读文字（python 解析 docx）

用 python（zipfile 解 word/document.xml）读取 `$DOC` 的正文：业务流程、业务规则、参数、状态机、对象清单、文档内"实现过程"SQL 片段。文字提取丢失的部分由下一步看图补齐。

**必做**：从文档的 Background / Purpose / Scope / Business Requirements 章节 + 变更单(ISR…)说明 + `jira_issue.md` 的需求/评论中，**提炼"业务背景与需求目标"**（这支程序解决什么业务问题、涉及哪些主体/会计事件、本次变更要达成什么、为什么这么改），作为 Step 7 design.md **第 0 节**的素材。这是 design.md 的必填内容，不能省。

## Step 6 - 逐张读图（关键，不可省略）

用 **Read 工具**逐张打开 `$TARGET_DIR/images/image*.png`（含 emf 转出的 png）。跳过纯装饰图（logo/页眉）。对有信息量的图描述并抽取：
- 流程图：节点/泳道/失败回环
- 日记账账务分录示例：借贷方向、科目、金额、分组依据 —— **核对借贷是否平衡**
- 批名/命名示例、行说明示例
- 快码/弹性域配置截图：Code、attribute 栏位与取值
然后把图里逻辑与正文文字 + 内嵌 SQL 片段**对照**，记录不一致/存疑点。

> 张数多时可派 Agent（general-purpose）逐张读图并回传结构化要点，再并入主评审。`.emf` 转出的 png 若中文显示为方块，文字仍可从 EMF 文本流判读；提示 `sudo apt install fonts-wqy-zenhei` 可出可读中文图。

## Step 7 - 产出 design.md（业务规格）

`$TARGET_DIR/design.md`，作为"应然基线"供后续代码审核对照。

**强制**：design.md 必须以 `## 0. 业务背景与需求目标` 开头——用 Step 5 提炼的内容，2~5 句讲清业务背景、涉及主体/会计事件、本次变更目标与原因，让**不看源码的人也能理解**；**缺此节视为 design.md 不合格**。

```markdown
# {TICKET_ID} 业务设计规格：{功能名}
| 项 | 内容 |
|---|---|
| Jira / 变更单 | ... |
| RICEW / 对象 | 包名、并发短名、文件名 |
| 评审依据 | 设计文档 .docx（文字 + N 张截图）+ 内嵌 SQL 片段；无源码 |

## 0. 业务背景与需求目标（Why，**放最前、必写**）：这支程序解决什么业务问题、涉及哪些主体/会计事件、本次变更要达成什么、为什么这么改 —— 让读者不看源码也懂背景
## 1. 原流程 / 2. 新流程（含失败回环、状态机 N→P→E/I→F/S）
## 3. 本次改动点（变更单逐条）
## 4. 业务规则清单（可校验条目：取数维度/分组 group by/账户匹配/命名(批名)规则/金额计算与四舍五入/校验项）
## 5. 账务分录预期（来自账务示例截图：借贷方向、科目、金额、Intercom 对冲、税额拆分）
## 6. 参数 / 快码 / 弹性域映射
## 7. 关键假设与外部依赖（账户是否定稿/BR100/R2R 等）
```

## Step 8 - 产出 设计评审_{TICKET}.md

`$TARGET_DIR/设计评审_{TICKET_ID}.md`：

```markdown
# 设计评审 — {TICKET_ID} / {RICEW}
| 项 | 内容 |（含 评审依据/边界：仅设计文档、无源码、结论须以实际代码复核；截图 N/N 已解出）

## 1. 业务设计摘要（引 design.md）
## 2. 需求 ↔ 设计覆盖（表：变更单改动点 → 文档是否覆盖 → ✅/⚠️/❌）
## 3. 疑点清单（H-xx / M-xx，每条：位置/出处(正文行号·图名·SQL片段) → 问题 → 建议）
   严重度：HIGH=与需求不符/可能错账；MEDIUM=健壮性/口径不清。
   已核对通过项也列出（✅）。
## 4. Open Items（需 dev/业务逐条回复）
## 5. 上线建议（通过 / 暂不通过 + 理由）
```

**评审定位（重要，先读）**：本阶段评审的是 **"要去做什么 / 设计是否完整、自洽、可据以开发"，不是"是否已正确实现"** —— 需求大多**尚未开发**。
- 文档**截图默认是现状 / 示意图**：**不得据此判定实现对错，也不要求 dev 提供"改造后样张"**。**仅当文档明确标注该图是"已手工尝试的样例"时**，截图才用于实现一致性核对。
- 同理，"现状配置截图"（如冻结日记账=否）反映的是**当前环境**；本次需求要改成什么，属"待实现/部署项"，确认设计/部署步骤是否覆盖即可，不当"配置错误"。
- "上线建议"实为 **"设计是否可据以正确开发"**：HIGH = 需求未被设计覆盖 / 设计自相矛盾 / 规则缺失或有歧义致无法正确开发；**不要因"截图非改造后"判 HIGH**。

**评审准则**：
- 一致性主轴 = **正文描述 ↔ 文档内"实现过程"SQL/规则**，两者打架才记疑点；截图按上面"评审定位"处理（现状参考；仅声明为样例时参与核对）。
- 账务：借贷必须平衡；税额/金额四舍五入须自洽（如 不含税+税额=含税）。
- 命名/批名：流水号是否硬编码、字段顺序/个数、多组合是否区分。
- 取值口径：代码 vs 中文、快码匹配字段是否唯一。
- 未定稿项（账户待 BR100/R2R 等）一律进 Open Items，不计入"通过"。
- 截图无法判读（如 .emf 转换失败）须在报告中声明覆盖边界。

## Step 9 - git 跟踪 + 收尾

ticket 目录是独立 git repo（与 `/skill:ebs-jira-review-review` 共用同一仓库与 `.gitignore`）。**没初始化就初始化**（幂等，复用 lib 函数；review 后续跑也不会重复初始化），并提交本次设计评审产物。二进制/截图已被 `.gitignore` 排除，只追踪 design.md / 设计评审 / jira_issue.md。

```bash
ebsjr_git_init_ticket "$TARGET_DIR"
cd "$TARGET_DIR"
# 逐个 add（容错：缺失文件不中断其它；不用 git add -A 以免纳入 docx 解析中间产物）
for f in design.md "设计评审_${TICKET_ID}.md" jira_issue.md; do
  [ -f "$f" ] && git add "$f"
done
git commit -q -m "md-review: ${TICKET_ID} 设计评审（design.md + 设计评审报告）" 2>/dev/null \
  && echo "→ 已 git 提交设计评审产物" || echo "→ git 无变化，跳过提交"
```

打印两份产物路径。如需回传 Jira，提示用户跑 `/skill:ebs-jira-review-submit {TICKET_ID}`（submit 默认回传 CODE_REVIEW_*；如要回传设计评审，确认文件名后再传）。

</process>
