---
name: ebs-jira-review-submit
description: >-
  把 ebs-jira-review-review 生成的 CODE_REVIEW_TE-XXXX.md 回传到 Jira 作为附件，并自动添加中文评论（含放行决策留痕）。用法：/skill:ebs-jira-review-submit TE-XXXX [--dry-run]。触发词：回传 Jira、submit、上传评审结果。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: submit.md
---

> **pi 迁移版**（upstream: `submit.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
把 /skill:ebs-jira-review-review 生成的 `CODE_REVIEW_{TICKET_ID}.md` 回传到 Jira ticket：
1. 上传 md 作为 Jira 附件
2. 添加一条中文评论（时间戳 + 审阅人 + 完成标记 + 问题统计 + 上线建议 + 附件名）

**回传前必须预览 + 按钮确认**，避免误传。
</objective>

<config>
共享 /skill:ebs-jira-review-review 的配置文件 `~/.ebs_jira_review.conf`：

```
JIRA_BASE_URL=https://amwaycloud.atlassian.net
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=your_api_token
# REVIEWER 默认从 /rest/api/3/myself 自动取 displayName；显式设此变量可覆盖
# REVIEWER=Jimmy.Xie
```
</config>

<process>

## Step 1 - 解析参数 & 校验

```bash
# 加载 lib，使用 extract_ticket_id 等共享 helper
PLUGIN_LIB="$HOME/.pi/agent/ebs-jira-review/lib"
source "$PLUGIN_LIB/jira_helpers.sh"

DRY_RUN=0
POS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    *) POS+=("$a") ;;
  esac
done

# 用 extract_ticket_id 容错：args 里有 trailing 备注（如 "TE-1250 我需要澄清"）会被识别 + 忽略
TICKET_ID=$(extract_ticket_id "${POS[@]}") || {
  echo "✗ 没找到合法的 ticket key（如 TE-1250）"
  echo "  用法：/skill:ebs-jira-review-submit <TICKET_ID> [--dry-run]"
  exit 1
}

EXTRA_TEXT=$(printf '%s\n' "${POS[@]}" | grep -vxE "$TICKET_ID|--dry-run" | tr '\n' ' ' | sed 's/[[:space:]]*$//')
if [ -n "$EXTRA_TEXT" ]; then
  echo "ℹ 已识别 TICKET_ID=$TICKET_ID；忽略额外文本：「$EXTRA_TEXT」"
  echo "  如需补充澄清，请在 Step 4b 决策提问时以自由文本补充"
fi

[ "$DRY_RUN" = "1" ] && {
  echo "🔍 ───── DRY-RUN MODE ─────"
  echo "  不会上传附件 / 评论 / 加标签 — 仅打印计划"
  echo ""
}

source ~/.ebs_jira_review.conf 2>/dev/null
JIRA_WORK_DIR="${JIRA_WORK_DIR:-/mnt/c/Jira}"
TICKET_BASE="${TICKET_BASE:-$JIRA_WORK_DIR/ticket}"

# 新路径优先，旧路径兼容（迁移期遗留）
TARGET_DIR="${TICKET_BASE}/${TICKET_ID}"
if [ ! -d "$TARGET_DIR" ] && [ -d "/mnt/c/jira/${TICKET_ID}_attachments" ]; then
  TARGET_DIR="/mnt/c/jira/${TICKET_ID}_attachments"
fi
REVIEW_FILE="${TARGET_DIR}/CODE_REVIEW_${TICKET_ID}.md"

if [ ! -f "$REVIEW_FILE" ]; then
  echo "✗ 未找到评审文件：$REVIEW_FILE"
  echo "  请先运行 /skill:ebs-jira-review-review $TICKET_ID 生成评审文档"
  exit 1
fi
```

## Step 2 - 读取配置

```bash
source ~/.ebs_jira_review.conf

for v in JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN; do
  if [ -z "${!v}" ]; then
    echo "✗ ~/.ebs_jira_review.conf 缺少 $v"
    exit 1
  fi
done

# REVIEWER：conf 已显式设置 → 直接用；否则调 myself API 取当前 token 持有者 displayName
if [ -z "$REVIEWER" ]; then
  REVIEWER=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    "$JIRA_BASE_URL/rest/api/3/myself" | jq -r '.displayName // empty')
fi
[ -z "$REVIEWER" ] && REVIEWER="Reviewer"

# 三合一预检：project + assignee=我 + status ∈ {Approval-Dev, Approval-QA, Validation-QA}
PLUGIN_LIB="$HOME/.pi/agent/ebs-jira-review/lib"
source "$PLUGIN_LIB/jira_helpers.sh"
jira_preflight "$TICKET_ID"
echo "→ 预检通过：$TICKET_ID @ $EBSJR_STATUS （reporter=$EBSJR_REPORTER_NAME）"
```

## Step 2c - DRY-RUN 早退（如启用）

```bash
if [ "$DRY_RUN" = "1" ]; then
  REVIEW_BYTES=$(stat -c %s "$REVIEW_FILE" 2>/dev/null || echo "?")
  BATCH_NUM=$(grep -c "^## 批次" "$REVIEW_FILE" 2>/dev/null || echo "?")
  echo "──────────────────────────────────────────────"
  echo "[DRY-RUN] 计划"
  echo "  Ticket:    $TICKET_ID"
  echo "  评审文件:  $REVIEW_FILE ($REVIEW_BYTES bytes, 共 $BATCH_NUM 批次)"
  echo ""
  echo "  将要执行（如非 dry-run）："
  echo "    1. 解析 CODE_REVIEW.md 末批次的统计 + 上线建议 + CRITICAL/HIGH 列表"
  echo "    2. 上传文件至 Jira: CODE_REVIEW_${TICKET_ID}_<timestamp>.md"
  echo "    3. POST 评论到 $TICKET_ID（ADF 格式 + @reporter）"
  echo "──────────────────────────────────────────────"
  exit 0
fi
```

## Step 2b - 计算上传时使用的附件名（带时间戳）

本地文件保持 `CODE_REVIEW_{TICKET_ID}.md` 不变（git 历史干净），但**上传到 Jira 时改名为带时间戳版本**，便于在 Jira 附件列表里区分多次评审上传：

```bash
UPLOAD_TS=$(date '+%Y%m%d-%H%M')          # 例：20260430-1015
UPLOAD_NAME="CODE_REVIEW_${TICKET_ID}_${UPLOAD_TS}.md"
echo "上传文件名：$UPLOAD_NAME"
```

后续 Step 4 / 4b 评论模板中的 `{附件名}` 占位以及 Step 6a 的 curl `-F` 上传都使用 `$UPLOAD_NAME`。

## Step 3 - 从 CODE_REVIEW.md 提取摘要（评论模板用）

用 Read 工具读 `$REVIEW_FILE`，提取以下信息（Claude 自己解析 md 内容）：

1. **问题统计**：找最后一个"统计"段或"**统计**："行。期望得到类似：
   - `HIGH × 1 / LOW × 2 / NIT × 2`（或 `FIXED × 3, PARTIAL × 2, OPEN × 1` 这种再次评审风格）
   - 解析失败 → 填 `详见附件`

2. **上线建议**：找 `## 上线建议` / `## 推荐决策` / `**上线建议**` 章节的第一句话。期望开头是"放行"/"条件放行"/"暂缓"/"可上线"/"可放行"之一。
   - 只取一句话（到句号/换行为止），去除 markdown 加粗符号
   - 解析失败 → 填 `详见附件`

3. **最新批次号**：`grep -c "^## 批次" $REVIEW_FILE`

4. **CRITICAL / HIGH 问题列表**：从 md 中抽取**当前批次**下所有 `### C-XX — 标题` / `### H-XX — 标题` 行（**仅 OPEN / 未 FIXED 状态**，再次评审时已 VERIFIED/FIXED 的不再列入），按编号升序产出 `(编号, 标题)` 数据对，留给 Step 4 / Step 6b 构造 ADF `bulletList` 节点（编号打 `code` mark，标题为普通 text）。
   - 例：`H-01` + ` Checksum 比对在指定员工/公司参数下永远失败`（编号会渲染成等宽小框）
   - 没有 CRITICAL/HIGH 项时返回空数组（Step 4 #4/#5 段落省略）
   - **编号一律打 `code` mark**：避免 Jira Cloud 把 `H-01`/`C-02` 这类 `KEY-NUM` 模式当作跨 site/space 的 issue key 自动 smart-link 命中假阳性。所有出现编号的位置（列表项、决策语阻断项摘要）一律遵循此规则。

## Step 3b - 查询 @ 对象（ticket 报告人）

评论必须 @ ticket 的**报告人**（reporter）—— 这是这套 EBS 客制工作流里默认的代码提交人 / 责任开发，例如 TE-1309 的 reporter 是 Qinqin Xu（实际开发并发起 review）。assignee 通常是 QA / 测试，不应作为 @ 对象。

```bash
REPORTER_JSON=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID?fields=reporter")

MENTION_ID=$(echo "$REPORTER_JSON" | jq -r '.fields.reporter.accountId // empty')
MENTION_NAME=$(echo "$REPORTER_JSON" | jq -r '.fields.reporter.displayName // empty')

if [ -n "$MENTION_ID" ]; then
  echo "@ 对象：$MENTION_NAME (accountId=$MENTION_ID)"
else
  echo "⚠ ticket 无报告人，本次评论无 @-mention"
fi
```

如 `MENTION_ID` 为空（极少见，ticket 无 reporter）→ 评论不加 @，预览里打印警告即可，不阻塞流程。

## Step 4 - 设计评论结构（语义层）

**语气要自然，别像 bot 打卡**。采用叙述式中文，而不是"字段: 值"的机械清单。
**评论是 Jira 上下文里的对话**，因此**不重复时间戳**（Jira 自带）和**不重复审阅人署名**（评论作者 = 当前 token 持有者，前端会显示头像和姓名）。

> ## 重要：API 与格式选型
>
> 本命令使用 **Jira Cloud REST API v3 + ADF (Atlassian Document Format)** 发评论。
> - **不要**用 v2 + Wiki Markup —— Jira Cloud 在中文/标点边界识别不稳定（紧邻"，""—""、"等非 ASCII 字符时 `*粗体*`、`{{code}}` 不渲染）
> - **不要**写 markdown 字符串 —— Jira API 任何版本都不接受 markdown，会被原样显示为 literal text
> - **不要**用 v2 fallback —— v2 的 plain-text autoformat 在 Cloud 端是 deprecated 行为，未来可能完全失效
>
> 参考：[ADF 结构](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/) | [JRACLOUD-77436](https://jira.atlassian.com/browse/JRACLOUD-77436)（markdown→ADF 转换 endpoint 仍为 open feature request）

评论按"段落清单"思考，每段对应一个 ADF block 节点。完整段落顺序如下，缺则省略：

| # | 段类型 | ADF block 节点 | 内容规则 |
|---|---|---|---|
| 1 | @-mention | `paragraph` 含 `mention` inline 节点 | `MENTION_ID` 非空时存在；mention 节点 `attrs={"id": MENTION_ID, "text": "@" + MENTION_NAME}` |
| 2 | 开篇句 | `paragraph` 含 `text` | 见下方"开篇变体" |
| 3 | 统计句 | `paragraph` 含 `text` | "本轮发现 {STATS}。"；STATS 来自 Step 3 第 1 项 |
| 4 | 严重项标题 | `paragraph` 含 `text` | "⚠ 严重 / 高风险问题："；CRITICAL/HIGH 列表非空时存在 |
| 5 | 严重项列表 | `bulletList` → `listItem` × N → `paragraph` | 每项形如：`code(编号) + text(" " + 标题)`；列表为空时与 #4 一起省略 |
| 6 | 决策语 | `paragraph` 含混合 inline | 见 Step 4b "决策语 ADF 结构表" |
| 7 | 附件引导 | `paragraph` 含混合 inline | 形如：`text("详细可参考附件 ") + code(UPLOAD_NAME) + text("。")` |

**inline mark 规则**：
- 问题编号（如 `H-01`、`C-02`）→ `marks: [{"type": "code"}]`，理由：① smart-link 不会匹配 inline code；② 视觉对齐为等宽小框
- 决策标签（"可以放行"/"条件放行"/"暂缓上线"）→ `marks: [{"type": "strong"}]`
- 附件文件名 → `marks: [{"type": "code"}]`，理由：等宽便于复制 + 显著区分

**开篇句变体**（基于 Step 3 第 3 项的 `N`）：
- 首次审阅（N=1）：`完成首轮代码审阅。`
- 再次评审有修复：`完成新一轮代码复核，至此共 {N} 次审阅。`
- 仅状态更新（无新问题）：`更新审阅状态，至此共 {N} 次审阅。`；同时 #3 改为 `本轮无新发现，状态汇总详见附件。`，#4/#5 整段省略

**严重项列表项 ADF 节点示例**（编号 `H-01` / `C-02` 必须用 code mark；标题保留普通 text）：

```json
{
  "type": "listItem",
  "content": [{
    "type": "paragraph",
    "content": [
      { "type": "text", "text": "H-01", "marks": [{"type": "code"}] },
      { "type": "text", "text": " Checksum 比对在指定员工参数下永远失败" }
    ]
  }]
}
```

把"段落清单 + 各段输入数据"准备好，**不要**在此步拼字符串；具体 JSON 在 Step 6b 写文件时一次性生成。

## Step 4b - 用户决定放行 / 条件放行 / 暂缓

**评审报告里的"上线建议"是 agent 的判断，最终 go/no-go 必须由人决定。** 以文本列出下列选项让用户选定（输出后停下等待回复，未获答复不得继续）：

```
问题: 本批次最终决定？
选项（推荐项标 (推荐) — 默认匹配 md 中提取的"上线建议"）:
  1. 放行           → 决策语标签：可以放行
  2. 条件放行       → 决策语标签：条件放行 — {阻断项摘要}
  3. 暂缓 / 不放行  → 决策语标签：暂缓上线 — 需先处理 {阻断项}
  4. 取消           → 不上传不评论，整体退出
```

推荐项匹配规则（基于 Step 3 提取的"上线建议"首词）：
- "放行" / "可放行" / "Pass" / "可上线" → 默认推荐"放行"
- "条件放行" → 默认推荐"条件放行"
- "暂缓" → 默认推荐"暂缓 / 不放行"
- 解析失败 → 不标推荐，让用户自选

收到用户选择后，按下表构造决策语段落（一个 `paragraph` block，inline 节点序列）：

| 用户选择 | 决策语 ADF 段落（顺序为 inline 节点列表） |
| --- | --- |
| 放行 | `text("经评审，") + strong("可以放行") + text("。")` |
| 条件放行 | `text("经评审，") + strong("条件放行") + text(" — ") + {阻断项 inline 序列} + text("。")` |
| 暂缓 / 不放行 | `text("经评审，") + strong("暂缓上线") + text(" — 需先处理 ") + {阻断项 inline 序列} + text("。")` |
| 取消 | 直接 exit 0，跳过 Step 5 / 6 |

`{阻断项 inline 序列}` 由 Claude 从 md 的"上线建议"段中解析后构造，规则：
- 文中出现的问题编号（`H-01`/`C-02` 等模式）→ 拆成单独的 `code(编号)` 节点
- 其余文字保留为 `text(...)` 节点
- 例：原文 `H-01 破坏 checksum、H-02 跨请求污染未根除，需先修复` → `[code("H-01"), text(" 破坏 checksum、"), code("H-02"), text(" 跨请求污染未根除，需先修复")]`

提不到阻断项 → `text("详见附件")`。

把决策语段落作为 #6 节点暂存，留给 Step 6b 装配整个 ADF 文档。

## Step 4c - 决策 vs 评审结论不一致 → 强制澄清并回写 review

**触发条件**：用户在 Step 4b 选的决策与 Step 3 从 CODE_REVIEW.md 解析出的"上线建议"**不一致**时进入本步骤。

把两边都归一到 `{放行, 条件放行, 暂缓}` 三态后比较：
- review 原结论中的"可放行" / "可上线" → `放行`
- review 原结论中的"条件放行" → `条件放行`
- review 原结论中的"暂缓" / "不放行" / "拒绝" → `暂缓`
- 解析失败 → 视为 `unknown`，强制走澄清（不能让人工无依据翻转）

**比较表**：

| review 结论 | 用户选 | 是否需澄清 |
|---|---|---|
| 放行 | 放行 | 否 |
| 条件放行 | 条件放行 | 否 |
| 暂缓 | 暂缓 | 否 |
| 任何 | 与 review 结论不一致 | **是** |
| unknown | 任何 | **是**（无依据时也要留痕） |

> 评审说"暂缓"但人工要"放行"是最危险的翻转，必须留下书面理由；反向（评审"放行"但人工要"暂缓"）也要留痕，方便事后追溯到底是发现了新风险还是只是过度谨慎。

### 4c-1. 收集澄清理由（文本提问）

```
问题: review 原结论是「{review_concl}」，本次决策为「{user_decision}」，请说明翻转/降级理由（用户可直接回复自由文本）

选项（可加 (推荐) — 视 review 结论与翻转方向适配）：
  1. 业务核实接受 — {一句话摘要}                        （推荐：暂缓 → 放行场景）
  2. 部署侧已兜底（运维流程 / 索引 / 顺序）— {摘要}     （推荐：条件放行 → 放行）
  3. 发现新风险，本次先不放                              （推荐：放行 → 暂缓）
  4. 其他（Other 自由输入）
```

让用户以一句话或多句话直接回复。允许多行；调用方收到后保留全文（不要二次截断）。

### 4c-2. 把澄清块**追加到最新批次内部**（不新增批次号）

定位 CODE_REVIEW.md 中**第一个** `## 批次` 标题（按 skill 约定，最新批次在最上面），在它对应批次的**末尾**插入澄清子节，**不**升批次号、**不**新建 `## 批次 N+1`。

> 为什么不新建批次？澄清不是新一轮代码审阅，是同一轮内 reviewer 与业务对话的留痕。给它升一档批次会让"批次计数 = 评审轮次"这个语义破裂。也避免下次 review skill 把澄清误判为评审历史。

**找插入点的规则**（伪代码）：

```
lines = read review.md
batch_indexes = [i for i, line in enumerate(lines) if line.startswith("## 批次 ")]
last_batch_start = batch_indexes[0]            # 文件中第一个出现 = 最新批次（倒序约定）
next_batch_start = batch_indexes[1] if len(batch_indexes) >= 2 else None
summary_start = next index of line starting with "## 问题汇总表" after last_batch_start

# 插入点 = 最新批次正文之后、下一个分隔（下个批次 或 问题汇总表）之前
insert_at = min(filter(None, [next_batch_start, summary_start])) - 1   # 退一行避开分隔的空行
# 再回退到最后一个非空行之后插入，避免多余空行
while lines[insert_at].strip() == "" and insert_at > last_batch_start:
    insert_at -= 1
insert_at += 1   # 落到最后一个非空行之后
```

**澄清块 markdown 模板**（追加到 insert_at 位置）：

```markdown

### 提交时澄清（{YYYY-MM-DD HH:MM} — {REVIEWER}）

**Review 原结论**：{review_concl}
**提交决策**：{user_decision}
**翻转/降级理由**：{用户输入的全文}

> 本节为 /skill:ebs-jira-review-submit 阶段的人工澄清，不计入新批次；如需修订澄清内容，下次 submit 时会在末尾追加新一条，不覆盖历史澄清。
```

注意事项：
- 同一批次可以累积多次澄清（如果用户多次 submit 之间持续翻转）。最新追加在最末尾，**不删历史澄清**。
- 澄清块的 `**Review 原结论**` 取自 Step 3 第 2 项原文（不要重格式化）。`**提交决策**` 取 Step 4b 用户选择的标签。

### 4c-3. 把澄清同步反映到决策语 ADF 段（Step 4b #6 节点）

如果走到 4c，**重写** Step 4b 输出的决策语段落：在原决策语末尾追加"（说明：…）"。具体规则：

| 翻转方向 | 决策语模板 |
|---|---|
| 任何 → 放行 | `text("经评审，") + strong("可以放行") + text("（说明：" + 澄清摘要 + "）。")` |
| 任何 → 条件放行 | `text("经评审，") + strong("条件放行") + text(" — ") + {阻断项 inline} + text("（说明：" + 澄清摘要 + "）。")` |
| 任何 → 暂缓 | `text("经评审，") + strong("暂缓上线") + text(" — ") + {阻断项 inline} + text("（说明：" + 澄清摘要 + "）。")` |

`澄清摘要` 取用户输入的前 60 个字符；超过 60 字符截断并补 `…`。**完整理由**已写入 review.md，Jira 评论里仅放摘要，避免评论冗长。

### 4c-4. 在末尾输出阶段（Step 8）追加澄清回执行

Step 8 末尾汇总的 `评审决策` 行后面再加一行：

```
澄清:        已追加到 CODE_REVIEW_{TICKET_ID}.md 的批次 N 末尾（不升批次号）
```

让用户清楚知道翻转留痕已落地。

### 4c-5. git commit 澄清写回

Step 4c-2 修改了 CODE_REVIEW md，需要在 Step 6c 的 git commit 之前**单独**起一个 commit 把澄清落库：

```bash
cd "$TARGET_DIR"
git add CODE_REVIEW_${TICKET_ID}.md
git commit -m "${TICKET_ID}: 批次 ${BATCH_NUM} submit 澄清（${review_concl} → ${user_decision}）" 2>/dev/null
```

这条 commit 在 Step 6c 的"已回传 Jira"empty commit 之前发生，保证 git 历史里**先记下澄清，再记下回传**。如果 4c-2 写入失败（极少见，可能是 md 结构异常找不到批次），整体退出 1，**不要继续走 Step 5+**——澄清留痕是放行的前置条件。

**完整 ADF 评论示例**（首轮、条件放行、含 2 个 HIGH 项，对应 TE-1484 真实评论结构）：

```json
{
  "body": {
    "version": 1,
    "type": "doc",
    "content": [
      { "type": "paragraph", "content": [
        { "type": "mention", "attrs": { "id": "6324a098a408c1e3a65934ac", "text": "@Qinqin Xu" } }
      ]},
      { "type": "paragraph", "content": [
        { "type": "text", "text": "完成首轮代码审阅。" }
      ]},
      { "type": "paragraph", "content": [
        { "type": "text", "text": "本轮发现 HIGH × 2 / MEDIUM × 3 / LOW × 2 / NIT × 1。" }
      ]},
      { "type": "paragraph", "content": [
        { "type": "text", "text": "⚠ 严重 / 高风险问题：" }
      ]},
      { "type": "bulletList", "content": [
        { "type": "listItem", "content": [
          { "type": "paragraph", "content": [
            { "type": "text", "text": "H-01", "marks": [{"type": "code"}] },
            { "type": "text", "text": " Checksum 比对在指定员工/公司参数下永远失败" }
          ]}
        ]},
        { "type": "listItem", "content": [
          { "type": "paragraph", "content": [
            { "type": "text", "text": "H-02", "marks": [{"type": "code"}] },
            { "type": "text", "text": " PROCESS_DATA \"Batch ID is Null\" 分支查询缺 request_id 过滤" }
          ]}
        ]}
      ]},
      { "type": "paragraph", "content": [
        { "type": "text", "text": "经评审，" },
        { "type": "text", "text": "条件放行", "marks": [{"type": "strong"}] },
        { "type": "text", "text": " — " },
        { "type": "text", "text": "H-01", "marks": [{"type": "code"}] },
        { "type": "text", "text": " 破坏 checksum、" },
        { "type": "text", "text": "H-02", "marks": [{"type": "code"}] },
        { "type": "text", "text": " 跨请求污染未根除，需先修复。" }
      ]},
      { "type": "paragraph", "content": [
        { "type": "text", "text": "详细可参考附件 " },
        { "type": "text", "text": "CODE_REVIEW_TE-1484_20260430-1027.md", "marks": [{"type": "code"}] },
        { "type": "text", "text": "。" }
      ]}
    ]
  }
}
```

> 此示例已在生产 ticket TE-1484 验证渲染：mention/code/strong 全部正确，无 smart-link 误识别。后续评论按此结构变换段落即可。

## Step 5 - 预览 + 按钮确认

打印预览（纯文本到屏幕）。决策语已经由 Step 4b 选定，此处只需用户确认上传动作：

```
────────────────────── 回传预览 ──────────────────────
目标 ticket: {TICKET_ID}
Jira URL:    {JIRA_BASE_URL}/browse/{TICKET_ID}
@-mention:   {MENTION_NAME}（报告人）   ← 若 MENTION_ID 为空则显示"⚠ 无报告人，本次无 @"
评审决策:    {放行 / 条件放行 / 暂缓上线}（用户在 Step 4b 确认）

即将上传附件:
  本地路径:   {REVIEW_FILE}
  上传文件名: {UPLOAD_NAME}   ← 带时间戳，便于在 Jira 附件区区分多次评审
  大小:       {文件字节数} bytes

即将添加评论（v3 + ADF；下方为可读语义视图，wire 格式是 ADF JSON）:
┌──────────────────────────────────────────────────
│ @{MENTION_NAME}
│
│ {开篇句}
│
│ 本轮发现 {STATS}。
│
│ ⚠ 严重 / 高风险问题：
│   • [code]H-01[/code] {标题}
│   • [code]H-02[/code] {标题}
│
│ 经评审，[strong]条件放行[/strong] — [code]H-01[/code] {阻断项摘要}。
│
│ 详细可参考附件 [code]{UPLOAD_NAME}[/code]。
└──────────────────────────────────────────────────
（[code]...[/code]/[strong]...[/strong] 是预览标注，发出去会渲染成等宽小框 / 粗体）
────────────────────────────────────────────────────
```

以文本向用户确认（"取消"已由 Step 4b 处理，这里只剩两个动作选项；输出选项后停下等待回复）：

```
问题: 确认回传到 Jira 吗？
选项:
  1. 确认回传（推荐）       → 上传附件 + 添加评论（含决策语）
  2. 仅上传附件不评论       → 只上传 md，不发评论
```

根据用户选择进入 Step 6 的不同分支。

## Step 6 - 执行 API 调用

> **API 路径分工**：附件上传走 v3（与评论一致，便于排错统一）；评论走 v3 + ADF。

**校验 ticket 存在**（避免 404 浪费请求）：
```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID")
if [ "$HTTP_CODE" != "200" ]; then
  echo "✗ 无法访问 $TICKET_ID（HTTP $HTTP_CODE）— 检查 ticket 号或 token 权限"
  exit 1
fi
```

### 6a. 上传附件（选项 1 和 2 都执行）

用 multipart 的 `;filename=` 语法在上传时改写文件名（本地文件不动）：

```bash
ATT_RESP=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -X POST \
  -H "X-Atlassian-Token: no-check" \
  -F "file=@${REVIEW_FILE};filename=${UPLOAD_NAME}" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/attachments")

ATT_ID=$(echo "$ATT_RESP" | jq -r '.[0].id // empty')
ATT_URL=$(echo "$ATT_RESP" | jq -r '.[0].content // empty')
ATT_NAME=$(echo "$ATT_RESP" | jq -r '.[0].filename // empty')

if [ -z "$ATT_ID" ]; then
  echo "✗ 附件上传失败"
  echo "$ATT_RESP" | jq .
  exit 1
fi

# 校验 Jira 实际接收到的文件名与本地预期一致
if [ "$ATT_NAME" != "$UPLOAD_NAME" ]; then
  echo "⚠ Jira 接收的文件名 ($ATT_NAME) 与预期 ($UPLOAD_NAME) 不一致，评论引用可能错位"
fi

echo "✔ 附件上传成功"
echo "  attachment_id: $ATT_ID"
echo "  filename:      $ATT_NAME"
echo "  下载 URL:      $ATT_URL"
```

### 6b. 添加评论（仅选项 1，使用 v3 + ADF）

按 Step 4 段落清单 + Step 4b 决策语段落，**用 Write 工具把完整 ADF 文档写到 `/tmp/jira_adf_body.json`**。文件最外层是 `{"body": {"version": 1, "type": "doc", "content": [...]}}`，content 顺序为 #1 mention → #2 开篇 → #3 统计 → #4 严重项标题 → #5 列表 → #6 决策语 → #7 附件引导（缺则省）。

> 用文件 + `--data-binary @file` 的原因：评论体含中文 + 多层嵌套 JSON，shell 字符串转义会踩字符截断/反斜杠陷阱。文件路径稳定可重放、便于失败时人工查看。

ADF 节点速查（构造时直接拷贝）：

| 元素 | JSON |
|---|---|
| 段落 | `{"type": "paragraph", "content": [...inline]}` |
| 列表 | `{"type": "bulletList", "content": [listItem...]}` |
| 列表项 | `{"type": "listItem", "content": [{"type": "paragraph", "content": [...inline]}]}` |
| 文本 | `{"type": "text", "text": "..."}` |
| 内联代码 | `{"type": "text", "text": "...", "marks": [{"type": "code"}]}` |
| 加粗 | `{"type": "text", "text": "...", "marks": [{"type": "strong"}]}` |
| @ 提及 | `{"type": "mention", "attrs": {"id": "<accountId>", "text": "@<displayName>"}}` |

发送：

```bash
COMMENT_RESP=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/jira_adf_body.json \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/comment")

COMMENT_ID=$(echo "$COMMENT_RESP" | jq -r '.id // empty')

if [ -z "$COMMENT_ID" ]; then
  echo "✗ 评论添加失败（附件已上传，需手动到 Jira 删除并重试）"
  echo "$COMMENT_RESP" | jq .
  echo "ADF 请求体保留在 /tmp/jira_adf_body.json，可人工修复后重发"
  exit 1
fi

echo "✔ 评论添加成功"
echo "  comment_id: $COMMENT_ID"
echo "  ADF body:   /tmp/jira_adf_body.json"
```

**常见 400 错误**：
- `Comment body is not valid!`：通常是 `version` 写错（必须 `1`）、根节点 `type` 不是 `"doc"`、或 mention 的 accountId 在该 site 不存在
- `Invalid mark type`：除 `code` / `strong` / `em` / `link` / `textColor` 等少量内置 mark 外，其它要查 ADF 文档
- 检查 `/tmp/jira_adf_body.json` 用 `jq .` 是否能 pretty-print，能则 JSON 至少格式合法

### 6c. 本地 git commit（记录回传历史）

```bash
cd "$TARGET_DIR"
if [ -d ".git" ]; then
  # 用空提交记录"已回传"事件（没有代码/文档变化）
  if [ -n "$COMMENT_ID" ]; then
    MSG="$TICKET_ID: 已回传 Jira（附件 $ATT_ID + 评论 $COMMENT_ID）"
  else
    MSG="$TICKET_ID: 已回传 Jira（仅附件 $ATT_ID，未评论）"
  fi
  git commit --allow-empty -m "$MSG" 2>/dev/null && echo "✔ 本地 git 已记录回传事件"
fi
```

### 6d. 写决策文件 + 不放行时改 assignee

**Step 4b 用户选择 → 决策值映射**：

| 用户选 | decision 值 | 后续动作 |
|---|---|---|
| 放行 | `approve` | 仅写决策文件；svn-commit 才会推动状态 + 改 assignee |
| 条件放行 | `approve` | 同上（条件由人工跟进，不阻断 commit） |
| 暂缓 / 不放行 | `reject` | 写决策文件 + **改 assignee=reporter**（不改 state，不调 svn-commit） |
| 取消 | （不写） | Step 4b 已 exit 0 |

`.review_decision.json` 记录到 ticket 目录：

```bash
case "$USER_DECISION" in
  "放行"|"条件放行")
    DECISION=approve
    NOTE="reviewer in $EBSJR_STATUS state chose 放行 (or 条件放行)"
    ;;
  "暂缓"*|"不放行"*)
    DECISION=reject
    NOTE="reviewer in $EBSJR_STATUS state chose 暂缓"
    # 改 assignee → reporter（dev），不改 state
    if jira_assign "$TICKET_ID" "$EBSJR_REPORTER_ID"; then
      echo "✔ 已把 $TICKET_ID 改派回 reporter ($EBSJR_REPORTER_NAME)"
    fi
    ;;
esac

ebsjr_write_decision "$TICKET_ID" "$DECISION" "$NOTE"
```

把 `.review_decision.json` 加入 ticket 目录的 `.gitignore`（review skill 已经在初始化 .gitignore，本命令首次写时自动追加）：

```bash
cd "$TARGET_DIR"
if [ -f .gitignore ] && ! grep -qx '.review_decision.json' .gitignore; then
  echo '.review_decision.json' >> .gitignore
fi
```

> 决策文件是会话状态，不入 git；svn-commit 启动时会读它判断本次能否推送。`.review_decision.json` 内容示例：
> ```json
> {"ticket":"TE-1463","decision":"approve","note":"...","decided_at":"2026-05-09T17:30:00",
>  "jira_status_at_decision":"Approval - Dev","reporter_at_decision":"Qinqin Xu"}
> ```

## Step 7 - 失败处理清单

| 状况 | 退出行为 |
| --- | --- |
| TICKET_ID 未传 | 打印用法并 exit 1 |
| CODE_REVIEW md 不存在 | 提示先跑 review 并 exit 1 |
| 配置缺失 | 打印缺哪个变量并 exit 1 |
| Ticket 访问返回 401/403 | 提示 token 权限问题并 exit 1 |
| Ticket 返回 404 | 提示 ticket 号错误并 exit 1 |
| 附件上传 413 | 提示文件超限（Jira Cloud 默认 10MB）并 exit 1 |
| 附件成功、评论失败 | 打印警告（附件已传，可手动删除后重试）并 exit 1 |

评论一旦发出即生效，Step 7 **不做回滚**，用户如需撤销自行到 Jira 删除。

## Step 8 - 末尾输出

成功后打印：

```
──────────────────────────────────────────────
✔ {TICKET_ID} 已回传 Jira

附件: {ATT_NAME}
      {ATT_URL}
评论: {JIRA_BASE_URL}/browse/{TICKET_ID}?focusedId={COMMENT_ID}

如需查看：{JIRA_BASE_URL}/browse/{TICKET_ID}
──────────────────────────────────────────────
```

</process>

<notes>
- 上传文件名带时间戳（`CODE_REVIEW_{TICKET}_{YYYYMMDD-HHMM}.md`）：本地保持单文件不变，Jira 附件区可按文件名直接看出哪一轮，无需依赖上传时间
- 评论正文里的"详细可参考附件 …"必须引用 `$UPLOAD_NAME`，与 Step 6a curl `;filename=` 指定的名字一致；不一致会让评论指向不存在的附件
- **评论用 Jira Cloud REST API v3 + ADF（Atlassian Document Format）**：
  - body 是结构化 JSON 树，根节点 `{"version": 1, "type": "doc", "content": [...]}`
  - 加粗 / 内联代码 / @-mention 都是显式 inline 节点的 `marks` 或 `attrs`，渲染 100% 可控
  - **不要回退 v2 + Wiki Markup**：在中文/标点边界识别不稳（紧邻"，""—""、"等会失败），TE-1484 实战已踩坑
  - **不要写 markdown**：Jira API 任何版本都不接受 markdown，UI 编辑器的 markdown 快捷键属于输入端能力，不通过 API
- **问题编号统一打 `code` mark**（如 `H-01`、`C-02`）：
  - 视觉效果：等宽小框，与正文区分
  - 副作用：Jira Cloud smart-link 不会扫 inline code 内容，规避跨 site 假阳性匹配
- ADF 节点白名单（本命令实际用到）：`paragraph` / `bulletList` / `listItem` / `text` / `mention`；marks：`code` / `strong`。其它节点按需查 [ADF 文档](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
- 上传 + 评论是两次独立请求，中间可能部分成功；Step 6b 失败会保留 `/tmp/jira_adf_body.json` 供人工修复重发
- Step 5 的确认必须列出编号选项让用户选择，不接受模糊的 Y/N（对齐原按钮交互语义）
- **Step 4c 决策澄清不可省**：人工翻转评审结论（如评审"暂缓"但用户选"放行"）必须先收集澄清理由并回写到 CODE_REVIEW.md 最新批次末尾，**不**升批次号；澄清块用 `### 提交时澄清（时间 — REVIEWER）` 三级标题，跟批次平行，便于事后追溯翻转动机。澄清写入失败整体退出 1，不放过"无书面理由的翻转"
- 同一批次可累积多次澄清（多次 submit 之间反复翻转），最新追加在末尾，历史澄清保留
- 此命令是 plugin `ebs-jira-review` 的 submit 子命令，与 `/skill:ebs-jira-review-review` 平级调用
</notes>
