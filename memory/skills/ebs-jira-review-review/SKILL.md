---
name: ebs-jira-review-review
description: >-
  从 Jira 下载 ticket 附件，解压后做代码和设计评审，生成 design.md 和 CODE_REVIEW_*.md。用法：/skill:ebs-jira-review-review TE-1456 [v2] [--dry-run]。触发词：EBS 评审、代码评审、再审、code review。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: review.md
---

> **pi 迁移版**（upstream: `review.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
自动化 Oracle EBS 定制开发的 Jira ticket 代码评审流程：
1. **先把本地 SVN 工作副本同步到最新**（`~/svn/xxamw/`），保证 diff 基于最新基线
2. 从 Jira REST API 下载附件（zip）
3. 解压到 `/mnt/c/Jira/ticket/{TICKET_ID}/` 目录
4. 与 SVN 基线对比，精确定位本次改动范围
5. 读取所有文件，生成 design.md（设计说明）和 CODE_REVIEW_{TICKET_ID}.md（代码评审）

支持多次评审：目录已存在时跳过下载，直接追加新一轮评审（带时间戳）到已有 CODE_REVIEW 文件。

**路径迁移期兼容**：旧 ticket 已存在于 `/mnt/c/jira/{TICKET_ID}_attachments/` 的，继续沿用旧路径完成本轮评审；新 ticket 一律走 `/mnt/c/Jira/ticket/{TICKET_ID}/` 新路径。
</objective>

<domain_context>
这是 Oracle E-Business Suite (EBS) R12.2 定制开发评审场景。

**SVN 基线位置**（`~/svn/xxamw/`，由 `/skill:ebs-jira-review-svn-init` 一次性签出，对应远程 `Trident/xxamw/`）：
- `sql/` — PL/SQL 文件平铺（`.pks/.pkb/.sql/.tbl/.vw/.syn` 等），文件名与附件同名
- `mds/` — OAF/MDS 扩展 JAR（`RICEW_ID_TE-XXXX.jar` 命名，按 ticket 累加）
- `java/` — Java 编译 JAR（`XXR2REXT8056GBLA.jar` 等）
- `xmlxdo/` — BIP XML/RTF 模板
- `workflow/` — 工作流定义 `.wft`

> Windows 客户端的 `C:\svn\xxamw\` 与本路径**双轨并行**，互不干扰。本 skill 只读 `~/svn/xxamw/`。

**附件文件类型分两大类：**

**① PL/SQL / DDL（直接对比 SVN）**
- `.pks` / `.pkb` — Package Spec / Body
- `.sql` — DDL 或升级脚本
- `.tbl` — 建表脚本
- `.prc` / `.fnc` / `.trg` — 独立存储过程/函数/触发器
- 基线位置：`~/svn/xxamw/sql/{同名文件}`

**② OAF/MDS JAR（需解压后对比）**
- JAR 内含 XML 元数据（VO/EO/Page 定义），无 `.class` 文件
- 命名规律：`{RICEW_ID}_TE-{N}.jar`（如 `D2D_EXT_8043_GBL_TE-1308.jar`）
- SVN 基线：同 RICEW_ID 前缀的最新版本 jar 在 `~/svn/xxamw/mds/`

**③ Java 编译 JAR（需解压查看）**
- JAR 内含 `.class` 编译文件
- 命名规律：`XX{MODULE}{ID}{SUFFIX}.jar`（如 `XXR2REXT8056GBLA.jar`）
- SVN 基线：`~/svn/xxamw/java/{同名文件}`
- 无 decompiler 时用 `javap -p` 查看方法签名

**设计文档**
- `.docx` / `.doc` — MD070 技术设计文档（docx 用 python zipfile/XML 解析；.doc 用 libreoffice headless 转 txt 或 olefile 粗提）
- `.xlsx` / `.xls` — 迁移清单（用 openpyxl 读取）
- `.xml` — BIP Data Template；`.rtf` — BIP Layout Template
</domain_context>

<config>
认证配置文件：~/.ebs_jira_review.conf

```
JIRA_BASE_URL=https://amwaycloud.atlassian.net
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=your_api_token
# 备选 cookie（API token 不可用时）：
# JIRA_COOKIE="cloud.session.token=xxx; atlassian.xsrf.token=yyy"

# 审阅人：默认从 Jira API 自动取当前 token 持有者的 displayName。
# 仅当想用别名覆盖时取消下行注释（罕见）：
# REVIEWER=Jimmy.Xie
```

REVIEWER 解析优先级：
1. **conf 显式设置**（如别名覆盖）→ 直接用
2. 否则调 `/rest/api/3/myself`，用 `displayName`
3. 都失败 → 兜底 "Reviewer"

传入 sub-agent 用于批次标题与评审署名。
</config>

<process>

## Step 1 - 解析参数

- TICKET_ID（必填，如 TE-1456）
- VERSION_SUFFIX（可选，如 v2）
- `--dry-run`（可选）：只验证 + 打印将要做什么，不动 Jira / SVN / 本地任何状态

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

# 用 extract_ticket_id 容错：从 args 中提取首个 TE-XXXX 模式
# 例：args="TE-1250 我有澄清" → TICKET_ID=TE-1250（trailing 备注被忽略，向调用方提示）
TICKET_ID=$(extract_ticket_id "${POS[@]}") || {
  echo "✗ 没找到合法的 ticket key（如 TE-1250）"
  echo "  用法：/skill:ebs-jira-review-review <TICKET_ID> [VERSION_SUFFIX] [--dry-run]"
  exit 1
}
# VERSION_SUFFIX 取 args 里非 ticket key 的第二个 token（如 v2）
VERSION_SUFFIX=$(printf '%s\n' "${POS[@]}" | grep -vxE "$TICKET_ID|--dry-run" | head -1)

# 提示用户已忽略的额外文本
EXTRA_TEXT=$(printf '%s\n' "${POS[@]}" | grep -vxE "$TICKET_ID|$VERSION_SUFFIX|--dry-run" | tr '\n' ' ' | sed 's/[[:space:]]*$//')
if [ -n "$EXTRA_TEXT" ]; then
  echo "ℹ 已识别 TICKET_ID=$TICKET_ID；忽略额外文本：「$EXTRA_TEXT」（如需附加说明请在交互阶段提出）"
fi

[ "$DRY_RUN" = "1" ] && {
  echo "🔍 ───── DRY-RUN MODE ─────"
  echo "  不会下载附件 / 写文件 / svn update / git commit"
  echo "  仅验证 config + project + ticket 存在性，然后列出计划"
  echo ""
}
```

目标目录解析（**新路径优先，旧路径兼容**）：

```bash
source ~/.ebs_jira_review.conf 2>/dev/null
JIRA_WORK_DIR="${JIRA_WORK_DIR:-/mnt/c/Jira}"
TICKET_BASE="${TICKET_BASE:-$JIRA_WORK_DIR/ticket}"

NEW_DIR="${TICKET_BASE}/${TICKET_ID}"
OLD_DIR="/mnt/c/jira/${TICKET_ID}_attachments"   # 已迁移前的遗留路径
[ -n "$VERSION_SUFFIX" ] && {
  NEW_DIR="${NEW_DIR}_${VERSION_SUFFIX}"
  OLD_DIR="${OLD_DIR}_${VERSION_SUFFIX}"
}

# 旧目录还在 → 沿用旧路径（保持已有评审历史/git 记录连续）
if [ -d "$OLD_DIR" ] && [ ! -d "$NEW_DIR" ]; then
  TARGET_DIR="$OLD_DIR"
  echo "→ 沿用旧路径：$TARGET_DIR（迁移期兼容）"
else
  TARGET_DIR="$NEW_DIR"
  mkdir -p "$TICKET_BASE"
fi
```

## Step 2 - 读取配置，验证环境

```bash
source ~/.ebs_jira_review.conf

# REVIEWER：conf 已显式设置 → 直接用；否则调 myself API 取当前 token 持有者 displayName
if [ -z "$REVIEWER" ]; then
  REVIEWER=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    "$JIRA_BASE_URL/rest/api/3/myself" | jq -r '.displayName // empty')
fi
[ -z "$REVIEWER" ] && REVIEWER="Reviewer"   # 兜底（API 失败 + conf 没配）
echo "REVIEWER=$REVIEWER"

for cmd in curl jq unzip diff; do command -v $cmd || echo "缺少：$cmd"; done
```

后续所有写入评审文档的位置必须使用 `$REVIEWER`：批次标题（`## 批次 N — ... ({REVIEWER} 首/再次审阅)`）和批次头部 `**审阅人**：$REVIEWER`。Sub-agent 调度时也要把 REVIEWER 作为参数传入。

## Step 2b - 三合一预检（project + assignee + status）

通过共享 helper `lib/jira_helpers.sh::jira_preflight` 一次性完成：
- project 校验（必须 == `JIRA_PROJECT_KEY`）
- assignee 校验（必须 == 当前 token 持有者）
- status 校验（必须 ∈ `Approval - Dev` / `Approval - QA` / `Validation - QA`）

校验通过后导出环境变量给后续步骤用：`EBSJR_STATUS` / `EBSJR_REPORTER_ID` / `EBSJR_REPORTER_NAME` / `EBSJR_ASSIGNEE_ID`。

```bash
PLUGIN_LIB="$HOME/.pi/agent/ebs-jira-review/lib"
source "$PLUGIN_LIB/jira_helpers.sh"

jira_preflight "$TICKET_ID"   # 失败会自己 exit 1
echo "→ 预检通过：$TICKET_ID @ $EBSJR_STATUS （reporter=$EBSJR_REPORTER_NAME）"
```

> 失败示例：
> - `assignee 是 'Qinqin Xu'，不是当前 token 持有者` → 在 Jira 改派后重跑
> - `状态 'Validation – Dev'，不属于本 plugin 处理范围` → 当前不该走 review

`jira_state` 内部带 60s 缓存（`/tmp/ebs_jira_state/{TICKET}.json`），同一 review/submit/svn-commit 链路里反复调用不会触发限流。

## Step 2c - DRY-RUN 早退（如启用）

dry-run 到此结束：列出附件清单 + 计划，不再继续。

```bash
if [ "$DRY_RUN" = "1" ]; then
  ATT_LIST=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID?fields=attachment,summary,reporter")

  ATT_COUNT=$(echo "$ATT_LIST" | jq '.fields.attachment | length')
  SUMMARY=$(echo "$ATT_LIST" | jq -r '.fields.summary')
  REPORTER=$(echo "$ATT_LIST" | jq -r '.fields.reporter.displayName // "未知"')

  echo "──────────────────────────────────────────────"
  echo "[DRY-RUN] 计划"
  echo "  Ticket:    $TICKET_ID — $SUMMARY"
  echo "  Reporter:  $REPORTER"
  echo "  目标目录:  $TARGET_DIR ($([ -d "$TARGET_DIR" ] && echo "已存在 → 再次评审" || echo "新建 → 首次评审"))"
  echo ""
  echo "  附件清单（$ATT_COUNT 个）："
  echo "$ATT_LIST" | jq -r '.fields.attachment[] | "    - \(.filename) (\(.size) bytes, \(.mimeType))"'
  echo ""
  echo "  将要执行（如非 dry-run）："
  echo "    1. svn update ~/svn/xxamw/  → 刷到 HEAD"
  echo "    2. 下载 + 解压附件到 $TARGET_DIR/"
  echo "    3. extract jar 到 extracted/{jarname}/"
  echo "    4. 对每个改动文件生成 diff/{basename}.diff"
  echo "    5. 写 design.md / CODE_REVIEW_${TICKET_ID}.md"
  echo "    6. git commit 评审产物"
  echo "──────────────────────────────────────────────"
  exit 0
fi
```

## Step 2e - 留痕检查（仅 QA 类状态）

按 Step 2b 拿到的 `EBSJR_STATUS` 决定是否做留痕检查，结果写到 `/tmp/ebs_jira_evidence_${TICKET_ID}.json`，sub-agent 会在 Step 6 读取并据此插入"留痕缺失"维度的 review 项。

**两种留痕检查**（互斥，按状态触发）：

```bash
EVIDENCE_FILE=/tmp/ebs_jira_evidence_${TICKET_ID}.json
echo '{}' > "$EVIDENCE_FILE"

case "$EBSJR_STATUS" in
  "Approval - QA")
    # 找测试痕迹：附件优先，评论其次，关键词 "测试"
    STATE_JSON=$(jira_state "$TICKET_ID")
    ATT_TEST=$(echo "$STATE_JSON" | jq -r '
      [.fields.attachment[]?
        | select(.filename | test("测试|test"; "i"))
        | "\(.filename) (by \(.author.displayName // "unknown"))"
      ] | join("|")')
    COMMENT_TEST=$(echo "$STATE_JSON" | jq -r '
      [.fields.comment.comments[]?
        | select((.body // "") | tostring | test("测试|test"; "i"))
        | "\(.author.displayName // "unknown")@\(.created // "")"
      ] | join("|")')

    if [ -n "$ATT_TEST" ] || [ -n "$COMMENT_TEST" ]; then
      EVIDENCE_OK=true
      echo "→ 测试痕迹：附件=[$ATT_TEST] 评论=[$COMMENT_TEST]"
    else
      EVIDENCE_OK=false
      echo "⚠ 未发现测试痕迹（附件或评论均无 '测试' 关键字）"
    fi

    jq -n --arg s "$EBSJR_STATUS" --argjson ok $EVIDENCE_OK \
          --arg a "$ATT_TEST" --arg c "$COMMENT_TEST" \
      '{check_type:"test_evidence", status:$s, found:$ok, attachments:$a, comments:$c}' \
      > "$EVIDENCE_FILE"
    ;;

  "Validation - QA")
    # 找改动说明：comment 中应含 "问题"/"调整"/"修改"/"修复" 等关键词
    STATE_JSON=$(jira_state "$TICKET_ID")
    EXPLAIN=$(echo "$STATE_JSON" | jq -r '
      [.fields.comment.comments[]?
        | select((.body // "") | tostring | test("问题|调整|修改|修复|fix|issue"; "i"))
        | "\(.author.displayName // "unknown")@\(.created // "")"
      ] | join("|")')

    if [ -n "$EXPLAIN" ]; then
      EVIDENCE_OK=true
      echo "→ 改动说明：[$EXPLAIN]"
    else
      EVIDENCE_OK=false
      echo "⚠ 评论中未发现改动说明"
    fi

    jq -n --arg s "$EBSJR_STATUS" --argjson ok $EVIDENCE_OK --arg c "$EXPLAIN" \
      '{check_type:"change_explanation", status:$s, found:$ok, comments:$c}' \
      > "$EVIDENCE_FILE"
    ;;

  *)   # Approval - Dev → 无需留痕检查
    jq -n --arg s "$EBSJR_STATUS" '{check_type:"none", status:$s, found:true}' \
      > "$EVIDENCE_FILE"
    ;;
esac
```

> Sub-agent 读到 `found:false` 必须在 CODE_REVIEW 中加一条独立 review 项：
> - `check_type=test_evidence` → "缺 dev 测试痕迹（建议 dev 在评论说明为何跳过测试）"，标 **HIGH**
> - `check_type=change_explanation` → "缺改动说明（QA 报告问题后应在评论说明本次改动修了什么）"，标 **HIGH**

## Step 2.5 - 同步 SVN 基线（review 必须基于最新 repo）

跑 `svn update`（或读 `/tmp/svn_update_summary.txt` 复用 1 小时内的最近一次同步结果），把 `$SVN_LOCAL_PATH`（默认 `~/svn/xxamw`，WSL ext4）刷到 HEAD。这一步**不可省略**：如果别人最近向 `mds/` 或 `sql/` 提交了同名文件，跳过 update 会让 Step 5 的 diff 基于过期基线，导致漏报或误报。

```bash
# 默认 SVN 工作副本走 WSL ext4，不放 /mnt/c（v9fs 上 wc.db 易损坏）
SVN_LOCAL="${SVN_LOCAL_PATH:-$HOME/svn/xxamw}"

if [ ! -d "$SVN_LOCAL/.svn" ]; then
  echo "✗ $SVN_LOCAL 不是 svn 工作副本"
  echo "  请先跑 /skill:ebs-jira-review-svn-init 完成首次签出"
  exit 1
fi

# 复用 1 小时内的同步摘要，避免重复 update
SUMMARY=/tmp/svn_update_summary.txt
RECENT=0
if [ -f "$SUMMARY" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$SUMMARY") ))
  [ "$AGE" -lt 3600 ] && RECENT=1
fi

if [ "$RECENT" = "0" ]; then
  echo "→ svn update（基线刷到最新）..."
  # 用 lib 的 svn_retry 自动重试网络抖动；auth 失败让用户 svn-init 重认证
  UPD_OUT=$(svn_retry "svn update" svn update "$SVN_LOCAL" 2>&1)
  UPD_RC=$?
  echo "$UPD_OUT" | tail -10
  case $UPD_RC in
    0) : ;;
    2) echo "✗ SVN auth 失败 — 跑 /skill:ebs-jira-review-svn-init 重认证后再来"; exit 1 ;;
    3) echo "✗ 工作副本冲突，先 resolve 再来"; exit 1 ;;
    *) echo "✗ svn update 失败 RC=$UPD_RC"; exit 1 ;;
  esac

  AFTER_REV=$(svn_retry "svn info" svn info "$SVN_LOCAL" \
    | awk -F': ' '/^版本: |^Revision: /{print $2; exit}')
  echo "✔ 基线已对齐到 r${AFTER_REV}"
else
  AFTER_REV=$(grep '^after_revision=' "$SUMMARY" | cut -d= -f2)
  echo "→ 复用 1 小时内的同步结果：r${AFTER_REV}"
fi

# 写入 design.md 头部用的 baseline revision
SVN_BASELINE_REV="$AFTER_REV"
```

> 这一步如果失败（auth cache 失效、网络问题、冲突），**整体停下**，提示用户跑 `/skill:ebs-jira-review-svn-update` 单独排查。不在脏基线上继续 review。

## Step 3 - 判断是首次还是再次评审

检查目标目录是否存在：
- **不存在**：首次评审，执行 Step 4 下载。
- **已存在**：再次评审（开发者可能已修复并重传附件）。打印"目录已存在，重新下载最新附件进行再次评审"，**先备份已有评审文件**，再执行 Step 4 重新下载。

```bash
IS_RERUN=false
if [ -d "$TARGET_DIR" ]; then
  IS_RERUN=true
  echo "目录已存在，重新下载最新附件进行再次评审..."
  # 备份已有评审文档（不被 unzip 覆盖）
  for f in "$TARGET_DIR"/design.md "$TARGET_DIR"/CODE_REVIEW_*.md; do
    [ -f "$f" ] && cp "$f" "${f}.bak"
  done
  # 清除旧的解压目录与 diff 目录，避免残留（diff 必须每轮重生成，让 git 能反映"本次重传后 diff 内容变化"）
  rm -rf "$TARGET_DIR"/extracted "$TARGET_DIR"/diff
  # 兼容老布局遗留（一次性清理；之后 review 都走新布局）
  rm -rf "$TARGET_DIR"/_extracted_* "$TARGET_DIR"/_svn_* "$TARGET_DIR"/_batch_diff_* "$TARGET_DIR"/_svn_diff_*
fi
```

## Step 4 - 下载并解压所有附件

```bash
# 获取 issue 完整信息（显式带 comment 字段，确保评论上下文齐全）
ISSUE_JSON=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/2/issue/$TICKET_ID?fields=summary,status,assignee,reporter,description,comment,created,updated")
ISSUE_ID=$(echo "$ISSUE_JSON" | jq -r '.id')

# 保存 Jira 说明 + 全部评论到 jira_issue.md（业务完整性审阅的原始依据）
# 评论按时间正序排列，每条带作者/时间戳/正文，便于跨批次回溯讨论历史
mkdir -p "$TARGET_DIR"
echo "$ISSUE_JSON" | jq -r '
"# " + .fields.summary + "\n\n" +
"**Ticket**：" + .key + "\n" +
"**状态**：" + .fields.status.name + "\n" +
"**经办人**：" + (.fields.assignee.displayName // "未分配") + "\n" +
"**报告人**：" + (.fields.reporter.displayName // "未知") + "\n" +
"**创建时间**：" + (.fields.created // "") + "\n" +
"**最后更新**：" + (.fields.updated // "") + "\n\n" +
"## 说明\n\n" + (.fields.description // "（无说明）") + "\n\n" +
"## 评论（" + ((.fields.comment.comments // []) | length | tostring) + " 条）\n\n" +
(
  (.fields.comment.comments // [])
  | if length == 0 then "（无评论）"
    else
      ( . | sort_by(.created)
        | map(
            "### " + (.author.displayName // "未知作者")
            + " — " + (.created // "")
            + (if .updated and .updated != .created then "（编辑于 " + .updated + "）" else "" end)
            + "\n\n"
            + (.body // "（空评论）")
          )
        | join("\n\n---\n\n")
      )
    end
)
' > "$TARGET_DIR/jira_issue.md"

COMMENT_COUNT=$(echo "$ISSUE_JSON" | jq -r '(.fields.comment.comments // []) | length')
echo "Jira 说明 + ${COMMENT_COUNT} 条评论已保存：$TARGET_DIR/jira_issue.md"

# 批量下载（Jira 内置端点，全部附件打成一个 zip）
curl -s -L -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -o /tmp/jira_bulk.zip \
  "$JIRA_BASE_URL/secure/attachmentzip/${ISSUE_ID}.zip"

mkdir -p "$TARGET_DIR"
# -O UTF-8: Jira 的 attachmentzip 端点把 UTF-8 文件名存进 zip 但不设 EFS flag (bit 11)，
# unzip 默认按 CP437 解读会让中文文件名变成 Cyrillic 乱码（如 "系统设置文档.docx" → "ч│╗ч╗Яшо╛ч╜оцЦЗцбг.docx"）
unzip -o -q -O UTF-8 /tmp/jira_bulk.zip -d "$TARGET_DIR"
rm /tmp/jira_bulk.zip

# 再次评审：还原备份的评审文档（覆盖 unzip 可能带来的旧版本）
if [ "$IS_RERUN" = true ]; then
  for f in "$TARGET_DIR"/design.md.bak "$TARGET_DIR"/CODE_REVIEW_*.md.bak; do
    [ -f "$f" ] && mv "$f" "${f%.bak}"
  done
fi
```

附件数量为 0 → 停止。解压失败 → 停止。

## Step 4b - Git 追踪（解压完成后）

每个 ticket 目录（`/mnt/c/Jira/ticket/{TICKET_ID}/` 或旧 `/mnt/c/jira/{TICKET_ID}_attachments/`）是**独立的 git repo**，互不干扰。

```bash
cd "$TARGET_DIR"

# git 初始化（幂等，复用 lib::ebsjr_git_init_ticket；与 md-review 共用同一仓库 / .gitignore）
# 注：若该 ticket 先跑过 /skill:ebs-jira-review-md-review，repo 与 .gitignore 已就绪，这里直接跳过。
ebsjr_git_init_ticket "$TARGET_DIR"

# stage 代码文件 + diff/ 目录（忽略二进制/图片/office/解压临时目录）
# diff/ 是关键：跨多次 review 的同名 diff 文件，git 会反映"本次重传后 diff 内容怎么变了"
git add *.pkb *.pks *.sql *.tbl *.prc *.fnc *.trg *.xml *.wft 2>/dev/null
git add diff/ 2>/dev/null

# 查看本次下载带来的变化（再次评审时最有价值）
GIT_DIFF=$(git diff --staged --stat 2>/dev/null)
if [ -n "$GIT_DIFF" ]; then
  echo "=== Git: 本次下载新增/变更文件 ==="
  echo "$GIT_DIFF"
  # 详细 diff（仅文本文件）
  git diff --staged -- "*.pkb" "*.pks" "*.sql" "*.tbl" "*.xml" 2>/dev/null
else
  echo "Git: 代码文件与上次提交无变化"
fi
```

> **再次评审时**：`git diff --staged` 直接显示开发者本次重传改了什么，是比 SVN diff 更精确的"本批次增量"视角。两者互补：SVN diff 看相对生产基线的全量改动，git diff 看相对上次评审的增量。

## Step 5 - 识别附件类型，处理 OAF JAR

用 Glob 列出目标目录所有文件，按类型分组：

### 5a. 处理 OAF/MDS JAR（XML 元数据类）

判断依据：JAR 命名含 `EXT_`，或解压后内容为 `.xml` 文件（无 `.class`）。

**目录布局规范**（所有解压、所有 diff 都遵守）：

```
{TARGET_DIR}/
├── extracted/                           ← 所有解压目标（gitignore'd）
│   ├── {jar_basename_without_ext}/      ← 当前附件 jar 解压
│   └── {svn_baseline_jar_basename}/     ← SVN 基线 jar 解压（不同名，不会撞）
└── diff/                                ← 所有 diff（git 追踪，basename 命名）
    ├── XxButtonsCO.java.diff            ← jar 内某个改动文件
    └── XXR2REXT8058A.pkb.diff           ← PL/SQL 改动文件
```

**统一规则**：
- 解压目录 = `extracted/{源文件去扩展名}/`，不带任何前缀
- diff 文件 = `diff/{改动文件 basename}.diff`，**同名 → 多次 review 之间 git 自动追踪 diff 内容变化**
- 不再生成 "开发者前后版本对比"（_batch_diff_），review 只关心 "SVN 基线 vs 当前附件"

```bash
mkdir -p "$TARGET_DIR/extracted" "$TARGET_DIR/diff"

# 找到附件目录里的所有 jar（只看根，不进 extracted/）
JAR_FILES=$(find "$TARGET_DIR" -maxdepth 1 -name "*.jar")

for JAR in $JAR_FILES; do
  JARNAME=$(basename "$JAR")
  EXTRACT_DIR="$TARGET_DIR/extracted/$(basename "$JAR" .jar)"
  mkdir -p "$EXTRACT_DIR"
  unzip -q "$JAR" -d "$EXTRACT_DIR"

  # 判断是否是 OAF/MDS jar（含 xml 无 class）
  XML_COUNT=$(find "$EXTRACT_DIR" -name "*.xml" | wc -l)
  CLASS_COUNT=$(find "$EXTRACT_DIR" -name "*.class" -o -name "*.java" | wc -l)

  if [ "$XML_COUNT" -gt 0 ] && [ "$CLASS_COUNT" -eq 0 ]; then
    JAR_TYPE="OAF/MDS"
  elif [ "$CLASS_COUNT" -gt 0 ]; then
    JAR_TYPE="Java"
  else
    JAR_TYPE="Unknown"
  fi
  echo "$JAR_TYPE JAR: $JARNAME (xml=$XML_COUNT, class/java=$CLASS_COUNT)"

  # 找 SVN 基线 jar
  RICEW_PREFIX=$(echo "$JARNAME" | sed 's/_TE[-_][0-9]*[^.]*\.jar$//')
  if [ "$JAR_TYPE" = "Java" ]; then
    SVN_JAR="$SVN_LOCAL/java/$JARNAME"
    [ ! -f "$SVN_JAR" ] && SVN_JAR=""
  else
    SVN_JAR=$(ls $SVN_LOCAL/mds/${RICEW_PREFIX}*.jar 2>/dev/null | grep -v "$JARNAME$" | sort | tail -1)
  fi

  if [ -n "$SVN_JAR" ] && [ -f "$SVN_JAR" ]; then
    SVN_EXTRACT="$TARGET_DIR/extracted/$(basename "$SVN_JAR" .jar)"
    mkdir -p "$SVN_EXTRACT"
    unzip -q "$SVN_JAR" -d "$SVN_EXTRACT"
    echo "  SVN 基线：$(basename $SVN_JAR)"

    # 对每个差异文件生成 diff/{basename}.diff（仅文本，二进制跳过）
    diff -rq "$SVN_EXTRACT" "$EXTRACT_DIR" 2>/dev/null \
      | awk '/^Files / && /differ$/ {print $4}' \
      | while read -r NEW_FILE; do
          [ -z "$NEW_FILE" ] && continue
          # 二进制（class）跳过；只对源码/xml 生成 diff
          case "$NEW_FILE" in
            *.class|*.so|*.dll|*.jar) continue ;;
          esac
          BASE=$(basename "$NEW_FILE")
          OLD_FILE=$(echo "$NEW_FILE" | sed "s|$EXTRACT_DIR|$SVN_EXTRACT|")
          diff -u "$OLD_FILE" "$NEW_FILE" > "$TARGET_DIR/diff/$BASE.diff"
          echo "  diff/$BASE.diff"
        done
  else
    echo "  未找到 SVN 基线 jar"
  fi
done
```

用 Read 工具读取解压出来的 XML 文件内容；diff 文件已落到 `diff/{basename}.diff`，下游 sub-agent 直接读 `diff/` 目录即可。

### 5b. 处理 PL/SQL / DDL 文件 — 按类型分组

附件目录里的 SQL 文件按**评审权重**分三类，分别落到不同子目录便于 sub-agent / 评审员**优先看业务逻辑、声明类后看**：

| 类别 | 扩展名 | 评审权重 | 输出目录 |
|---|---|---|---|
| **业务逻辑** | `.pkb` / `.pks` / `.prc` / `.fnc` / `.trg` / `.sql`（DML/升级脚本） | 高 — 改动有副作用 | `diff/` |
| **视图** | `.vw` | 中 — 业务查询语义 | `diff/` |
| **DDL 声明** | `.tbl` / `.idx` / `.seq` / `.syn` | 低 — 结构定义，改动通常机械 | `diff/decl/` |

```bash
mkdir -p "$TARGET_DIR/diff" "$TARGET_DIR/diff/decl"

# 分类匹配函数
classify_diff_dir() {
  case "$1" in
    *.tbl|*.idx|*.seq|*.syn) echo "$TARGET_DIR/diff/decl" ;;
    *)                       echo "$TARGET_DIR/diff" ;;
  esac
}

for SRC_FILE in $(find "$TARGET_DIR" -maxdepth 1 -type f \( \
    -name "*.pks" -o -name "*.pkb" -o -name "*.sql" \
    -o -name "*.tbl" -o -name "*.prc" -o -name "*.fnc" -o -name "*.trg" \
    -o -name "*.vw" -o -name "*.syn" -o -name "*.seq" -o -name "*.idx" \) | sort); do

  FNAME=$(basename "$SRC_FILE")
  SVN_FILE="$SVN_LOCAL/sql/$FNAME"
  DIFF_DIR=$(classify_diff_dir "$FNAME")
  DIFF_OUT="$DIFF_DIR/$FNAME.diff"

  if [ -f "$SVN_FILE" ]; then
    diff -u "$SVN_FILE" "$SRC_FILE" > "$DIFF_OUT" 2>/dev/null
    if [ -s "$DIFF_OUT" ]; then
      LINES=$(wc -l < "$DIFF_OUT")
      REL=${DIFF_OUT#$TARGET_DIR/}
      echo "  $REL ($LINES 行 vs SVN 基线)"
    else
      rm -f "$DIFF_OUT"
    fi
  else
    diff -u /dev/null "$SRC_FILE" > "$DIFF_OUT" 2>/dev/null
    REL=${DIFF_OUT#$TARGET_DIR/}
    echo "  $REL（新增对象，SVN 无基线）"
  fi
done

# 打印分类汇总，让 sub-agent / 用户一眼看到评审重心
LOGIC_COUNT=$(find "$TARGET_DIR/diff" -maxdepth 1 -name "*.diff" 2>/dev/null | wc -l)
DECL_COUNT=$(find "$TARGET_DIR/diff/decl" -maxdepth 1 -name "*.diff" 2>/dev/null | wc -l)
echo ""
echo "── diff 分类汇总 ──"
echo "  业务逻辑/视图 (diff/):       $LOGIC_COUNT 个 ← 评审重点"
echo "  DDL 声明     (diff/decl/):   $DECL_COUNT 个 ← 机械性变更，速读即可"
```

**diff 命名 / 布局规范**：
- 业务逻辑 + 视图：`diff/{basename}.diff`
- DDL 声明：`diff/decl/{basename}.diff`
- jar 内文件：`diff/{basename}.diff`（OAF/Java 类源码同业务逻辑）

多次 review 同名覆盖；git 追踪 `diff/` 后能看到"本次重传相对上次评审差异"。

**评审时优先级**：先读 `diff/*.diff`（业务/视图）→ 看 `diff/decl/*.diff` 是否符合 declaration 类的常见变更模板（如 `cache N` / `UNIQUE` / `_N1` 索引），后者通常 1-2 行/文件，不必逐行审。

## Step 5c - 加载开发规范上下文

把 `EBSJR_STANDARDS_DIR` 目录下**所有 *.md** 作为详细规范挂载（递归 maxdepth=4），由 sub-agent 按需 grep。不在 plugin 里硬编码文件名 — 规范库未来扩张/重命名都不用改 plugin 代码。

- **baseline**：conf 显式指定的那份（`EBSJR_STANDARDS_BASELINE`，默认 `develop-standard/CLAUDE.md`），每次评审都加载全文作为 must-known 清单 — 命名/EBR/PL/SQL 前缀/对象路径等核心规则
- **详细规范**：通读 STANDARDS_DIR 下所有 *.md path 列表（不读全文，sub-agent 自己 grep 相关章节）
- **跳过**：baseline 自身（避免重复） + `known-docs/` 子目录（原始 docx/pdf 参考资料，已经在 md 摘要里）
- **监控阈值**：
  - 文件数 > `EBSJR_STANDARDS_MAX_FILES`（默认 30）→ WARN
  - 总字节 > `EBSJR_STANDARDS_MAX_TOTAL_BYTES`（默认 1 MiB）→ WARN
  - 单文件 > `EBSJR_STANDARDS_MAX_FILE_BYTES`（默认 256 KiB）→ **drop**，列入 `stats.dropped[]`
  - baseline > `EBSJR_STANDARDS_BASELINE_MAX_BYTES`（默认 64 KiB）→ 只返回 path，content 留空避免撑爆 prompt

```bash
. ~/.pi/agent/ebs-jira-review/lib/jira_helpers.sh
STD_JSON=$(ebsjr_load_standards "$TARGET_DIR")
echo "$STD_JSON" > /tmp/ebs_jira_standards_${TICKET_ID}.json

STD_BASELINE_PATH=$(echo "$STD_JSON" | jq -r '.baseline_path // empty')
STD_DETAIL_COUNT=$(echo "$STD_JSON" | jq -r '.detail_paths | length')
STD_BL_BYTES=$(echo "$STD_JSON" | jq -r '.stats.baseline_bytes')
STD_TOTAL=$(echo "$STD_JSON" | jq -r '.stats.total_bytes')
STD_DROPPED=$(echo "$STD_JSON" | jq -r '.stats.dropped | length')

if [ -n "$STD_BASELINE_PATH" ]; then
  echo ""
  echo "── 开发规范上下文 ──"
  echo "  baseline:  $STD_BASELINE_PATH ($STD_BL_BYTES bytes)"
  echo "  详细规范:  $STD_DETAIL_COUNT 份，共 $STD_TOTAL bytes (sub-agent 按需 grep)"
  echo "  drop 文件: $STD_DROPPED 个（详见 stats.dropped）"
  echo "  ticket ext: $(echo "$STD_JSON" | jq -r '.matched_exts | join(",")')"
  # warnings 已经在 ebsjr_load_standards 内部打到 stderr 了
else
  echo "ℹ 规范目录未配置（conf 中 EBSJR_STANDARDS_DIR 为空），评审走通用准则"
fi
```

**评审时使用规范**：

1. **baseline 内容**已在 `STD_JSON.baseline_content` 中（也写到 `/tmp/ebs_jira_standards_${TICKET_ID}.json`）。主 context 把它当评审 must-known 清单：
   - EBR 强制：包/视图/同义词必须 EDITIONABLE，不直接引用基表
   - 命名：`XXAMW_<描述>_{PKG|V|S|TL|ALL|B|N{n}|U{n}}`
   - PL/SQL 前缀：`g_/l_/p_/c_/r_/t_`
   - 必含 `WHEN OTHERS` + `fnd_log`/`fnd_file.put_line`
   - 禁 `SELECT *`
   - Java 包名：`xxamw.oracle.apps`

2. **任何违反 baseline 的代码**在 CODE_REVIEW_xxx.md 中标 HIGH，并引用具体条款（如 "违反 develop-standard/CLAUDE.md > 命名标准 > 包"）

3. **sub-agent prompt**（如启用）会把 `/tmp/ebs_jira_standards_${TICKET_ID}.json` 路径作为输入，agent 自己按需读详细规范

## Step 5d - PL/SQL 上下文（本地多环境快照 + 同义词解析）

如果 ticket 涉及 PL/SQL 对象（`.pkb/.pks/.fnc/.prc/.vw/.tbl/.syn` 等），自动调 plugin 内嵌的 nodejs 子模块拉取这些对象（及一阶依赖、同义词）到本地缓存，再做 references / called_by 分析。

**前置条件**：用户必须先跑过 `/skill:ebs-jira-review-plsql-init` 装好 nodejs 依赖。

```bash
. ~/.pi/agent/ebs-jira-review/lib/jira_helpers.sh

# 检测 ticket 是否有 PL/SQL 类对象
HAS_PLSQL=0
if find "$TARGET_DIR/diff" -maxdepth 2 -name "*.diff" 2>/dev/null \
   | grep -qE '\.(pkb|pks|fnc|prc|trg|vw|mvw|tbl|idx|seq|syn)\.diff$'; then
  HAS_PLSQL=1
fi

PLSQL_CONTEXT_FILE="/tmp/plsql_context_${TICKET_ID}.json"

if [ "$HAS_PLSQL" = "0" ]; then
  echo "ℹ ticket 无 PL/SQL 对象，跳过 PL/SQL 上下文加载"
  echo "[]" > "$PLSQL_CONTEXT_FILE"
elif ! ebsjr_plsql_check_installed; then
  echo "⚠ PL/SQL 子模块未安装 — 评审将不带 references/called_by 上下文"
  echo "  下次跑 /skill:ebs-jira-review-plsql-init 装一次即可"
  echo "[]" > "$PLSQL_CONTEXT_FILE"
elif [ "${EBSJR_PLSQL_REFRESH_ON_REVIEW:-1}" = "0" ]; then
  echo "ℹ EBSJR_PLSQL_REFRESH_ON_REVIEW=0（离线模式），跳过拉取"
  echo "[]" > "$PLSQL_CONTEXT_FILE"
else
  echo "── 触发 PL/SQL 上下文加载 ──"
  echo "  调用 /skill:ebs-jira-review-plsql-refresh $TICKET_ID（透传，结果写到 $PLSQL_CONTEXT_FILE）"
  # pi 环境：读取 ~/.pi/agent/skills/ebs-jira-review-plsql-refresh/SKILL.md 并按其流程执行（参数 $TICKET_ID）；内部自动处理 TTL / DB 不可达回退
fi
```

> 按 ebs-plsql-refresh skill 的流程执行（参数 $TICKET_ID）：把对象列表 + 一阶依赖 + 同义词的 DDL/源码拉到本地 `{EBSJR_PLSQL_LOCAL_CACHE}/{env}/...`，并写上下文 JSON `/tmp/plsql_context_${TICKET_ID}.json`，包含每个对象的 `references`（含同义词解析）、`called_by`（本环境其它源码反查）、`freshness.pulled_at`。

**评审时使用 PL/SQL 上下文**：
- 任何 commit 涉及的对象删除/签名变更 ⚠️ 检查 `called_by[]` — 有调用方 = HIGH（破坏向下兼容）
- 任何引用了 `APPS.HZ_XXX` 等同义词的视图 ⚠️ 看 `references[].via_synonym=true` + `resolved` 字段判断真实对象，避免误判"未引用"
- `freshness.pulled_at` 大于 24h 时报告里要注明"PL/SQL 上下文基于 N 小时前快照"

## Step 6 - 读取文件，理解业务内容

按优先级读取：
1. **设计文档**：`.docx`（python zipfile/XML 解析）、`.xlsx/.xls`（openpyxl）
2. **diff 结果**：已在 Step 5 获取，重点理解每处改动的意图
3. **改动上下文**：对 diff 涉及的行，用 Read 工具读取前后各 30 行理解逻辑
4. **OAF XML**：读取解压出的 XML 文件

### 6a. Migration 文件专项审阅

Migration 文件固定命名格式：`{RICEW_ID}_Migration_{TICKET_ID}.xlsx`，固定含以下 9 个 sheet：

| Sheet | 关注点 |
|-------|--------|
| Agenda | 概览，无需审阅 |
| **1. Code Inventory** | ⭐ 核查代码清单完整性 |
| 2. Roles and Responsibilities | 无需审阅 |
| 3. Pre-requisite | 可扫一眼前置条件 |
| 4. Pre-deployment Instructions | 可扫一眼 |
| **5. Deploy Instructions** | ⭐ 核查部署步骤 |
| 6. Post Deployment Instructions | 可扫一眼 |
| 7. Back Out Instructions | 可扫一眼 |
| 8. Special Instructions | 可扫一眼 |

用 openpyxl 读取文件（python3 内嵌脚本），重点看以下两个 sheet：

**① Sheet "1. Code Inventory" — 代码清单完整性**

列结构：`RICE COMPONENT | FILE NAME | TYPE | SUBVERSION REVISION NUMBER | SUBVERSION FILE`

只核查 `FILE NAME` / `TYPE` 两列 — 对照 SVN diff 实际改动的文件，逐一核查是否列入清单：

| 检查项 | 实际改动文件 | Migration 中是否列出 | 备注 |
|--------|-------------|---------------------|------|
| PL/SQL | XXR2RRPT718A.pkb | ✅ / ❌ | |
| DDL    | XXD2DXXX.sql     | ✅ / ❌ | |
| OAF JAR| D2D_EXT_8043_GBL_TE-1308.jar | ✅ / ❌ | |

> **不要检查 `SUBVERSION REVISION NUMBER` 列** — 这是评审通过后由 `/skill:ebs-jira-review-svn-commit` 自动回填的字段。具体地：
> - 空 / 未刷新到本次 commit 的 revision：**评审阶段不算问题**（svn-commit Step 12 会自动回写本次涉及行）
> - 同一文件历史 revision 与本次不同：**正常**，多次 review 共存（TE-1302 实例：1253/1375/1377/1378 共存）
> - 仅当 Migration 文件**完全没有 `1. Code Inventory` sheet** 或 E 列（`SUBVERSION FILE`）写错路径前缀（不是 `Trident/xxamw/...`）时才记 HIGH

**② Sheet "5. Deploy Instructions" — 部署步骤**

列结构：`Seq # | DESCRIPTION | RESPONSIBILITY(TEAM)`

只检查以下明显的低级错误，不推断业务逻辑：
- **执行顺序错误**：建表（DDL）应在编译 pkb 之前；pks 应在 pkb 之前
- **依赖遗漏**：pkb 已列但 pks 未列
- **文件名/路径与 Code Inventory 不符**：步骤中引用的文件名拼写与清单对不上
- **DDL/DML 顺序风险**：先 INSERT 后 ALTER TABLE 等

**不要标的"问题"**（这些由部署流程兜底，不计入评审决策）：
- "缺 `drop index` / `drop sequence` 步骤会触发 ORA-00955" —— 若是**首次发布**（QA/PRD 中尚无目标对象）则 `create` 直接成功；若环境已存在残留 DBA 会现场协助 drop。仅在 Migration 明确写明"环境已存在该对象"语境下才记 MEDIUM。
- "Deploy Instructions 列出未改动 .tbl/.idx/.seq/.syn" —— 首次部署正常，不阻断。

结果写入 CODE_REVIEW 独立小节 `### Migration 清单审阅`。

## Step 7 - 生成 / 补充 design.md

文件路径：`{TARGET_DIR}/design.md`。

**与 md-review 协同（重要）**：若 `design.md` 已由 `/skill:ebs-jira-review-md-review` 生成（开头是"业务设计规格"，含业务规则清单 / 账务预期 / 命名规则等），**不要覆盖或重写其业务规格小节**——它是本次代码审核的对照基线（应然）。改为在文件**末尾追加一节**，把业务规格逐条对到代码实现：

```markdown
## 代码实现对照（SVN diff，{REVIEWER} {YYYY-MM-DD}）

| 业务规则 / 账务预期（design.md） | 对应实现位置（文件·行/对象） | 是否一致 | 备注 |
|---|---|---|---|
| 例：批名 = 日期+PaymentType+币种+请求号+流水号 | XXO2CITI8023A.pkb Lxxx | ⚠️ | 流水号硬编码 001 |

## MD 文档待修订建议（反向：实现 → MD，{REVIEWER} {YYYY-MM-DD}）

> 遍历 SVN diff 每处改动，回查 design.md / MD070 是否覆盖；**代码有而 MD 无 = MD 缺漏；代码与 MD 描述不符 = MD 过时**。这是给文档维护者的反馈，CR 必出。

| 代码改动（文件·行/对象） | MD/design.md 是否覆盖 | 问题类型 | 建议补充 / 修订 |
|---|---|---|---|
| 例：pkb 增加 org_id 过滤 | ❌ 未提及 | MD 缺漏 | 设计文档补"按 org_id 过滤"规则 |
| 例：批名实际含 settl_currency | ⚠️ 与正文不符 | MD 过时 | 修正设计文档批名描述 |
```

design.md **不存在**（无 md-review 前置）时，按下面结构新建；已存在本 skill 旧版 design.md（仅改动点清单、非业务规格）则照旧追加。

内容结构：
```markdown
# {TICKET_ID} 设计说明：{功能名称}

| 项 | 内容 |
|---|---|
| Jira | {TICKET_ID} |
| RICEW ID | ... |
| 对象名 | ... |

## 1. 原流程 (Current Business Process)
## 2. 新流程 (Future Business Process)
## 3. 改动点清单（基于 SVN diff）

| 文件 | 改动类型 | 关键行 | 说明 |
|------|----------|--------|------|
| XXX.pkb | 修改 | L1336 | ae_line_num → displayed_line_number |

## 4. 核心调用链
## 5. 关键假设与依赖
```

## Step 8 - 生成 CODE_REVIEW_{TICKET_ID}.md

文件路径：`{TARGET_DIR}/CODE_REVIEW_{TICKET_ID}.md`

**评审策略：两层审阅，缺一不可**

**第一层 — 业务完整性**（先做，优先级高于代码质量）：
**优先以 `design.md` 的业务规格（业务规则清单 / 账务预期，若 md-review 已生成）为对照基线**，做**双向核对**：
- **① 正向（MD → 实现）**：每条业务规则/账务预期是否都在代码实现，结果写入 Step 7「代码实现对照」表。
- **② 反向（实现 → MD）**：遍历 SVN diff 每处改动，回查 design.md/MD 是否有对应描述 —— **代码有而 MD 无 = MD 缺漏；代码与 MD 描述不符 = MD 过时**；写入 Step 7「MD 文档待修订建议」表，作为给文档维护者的反馈（CR 必出，不能只挑代码不管文档）。

无 design.md 业务规格时回退到设计文档 + Jira 需求描述。逐一确认每个需求点是否都有对应实现；重点检查：
- 改动是否覆盖了所有相关代码路径（同一逻辑在多处出现时是否全部改到）
- 需求里提到的场景，代码里是否有对应处理
- 改动点之间的联动是否自洽（如换表后关联字段、下游调用是否同步调整）

**第二层 — diff 质量**（在 diff 范围内做代码质量审查）：
以 SVN diff 为入口，对实际改动行及其周边逻辑做安全性和正确性检查。

### 文件结构（首次创建）

```markdown
# 代码审阅 — {TICKET_ID} / {RICEW_ID}

本文档记录对 {TICKET_ID} 交付物的历次代码审阅。

## 组织规则

- **多次审阅**：每次新增一个审阅批次 `## 批次 N — YYYY-MM-DD HH:MM`，按时间戳**倒序**排列（最新在上）。
- **批次内排序**：问题按严重程度降序排列，标签 `CRITICAL > HIGH > MEDIUM > LOW > NIT`。
- **问题编号**：`严重度简写-序号`，如 `C-01`、`H-02`。跨批次唯一递增；后续批次对同一问题补充或验证沿用旧编号。
- **问题状态**：`OPEN | FIXED | WONTFIX | VERIFIED`。
- **末尾问题总表**：每次审阅后重写，反映所有批次合并后的最新状态。

## 严重度定义

| 级别 | 含义 |
| --- | --- |
| CRITICAL | 导致数据错误、丢失、重复、程序不可用；必须修复才能上线。 |
| HIGH | 与需求不符 / 输出错误 / 潜在数据风险；强烈建议本版本修复。 |
| MEDIUM | 健壮性、可维护性、性能隐患；建议修复。 |
| LOW | 代码风格、命名、冗余；可择机清理。 |
| NIT | 吹毛求疵级别（注释、拼写）；可选。 |

---

## 批次 1 — {YYYY-MM-DD HH:MM}（{REVIEWER} 首轮审阅）

**审阅对象**：列出文件名及版本
**SVN 基线**：列出对比的基线文件/版本
**开发人**：{从 diff 中的 `-- TE-XXXX` 行内追溯注释或 pkb 头部修改历史里解析出来的开发者姓名，如 `qinqin.xu`；多人则全部列出；无法识别填"未知（源码无追溯注释）"}
**审阅人**：{REVIEWER}（默认从 Jira API `/rest/api/3/myself` 自动取 displayName；conf 中显式设 `REVIEWER` 可强制覆盖）
**审阅方法**：SVN diff 精准定位改动 + 静态代码阅读。未在 DB 环境实际执行。

---

### {C-01/H-01/...} [{级别}] {标题}

> **标题写法**：动词短语，直接点出缺陷，如"FORALL 未读 SQL%BULK_EXCEPTIONS"，不写"FORALL 异常处理不当"。

**位置**：`文件名` L行号

**问题**：一句话说明"做了什么 → 什么情况下会怎样"，然后直接给代码，不堆铺垫。

```sql
-- L1906 原始代码
FORALL i IN 1..l_tbl.COUNT SAVE EXCEPTIONS
  INSERT INTO xx_gtt ...;
EXCEPTION
  WHEN OTHERS THEN
    x_err_flag := 'E';   -- ← bulk 失败行静默丢失，SQL%BULK_EXCEPTIONS 从未读取
```

**改动建议**：

```sql
-- 修复后
EXCEPTION
  WHEN bulk_errors THEN
    FOR i IN 1..SQL%BULK_EXCEPTIONS.COUNT LOOP
      log('bulk error idx=' || SQL%BULK_EXCEPTIONS(i).ERROR_INDEX
          || ' code=' || SQL%BULK_EXCEPTIONS(i).ERROR_CODE);
    END LOOP;
    x_err_flag := 'E';
  WHEN OTHERS THEN
    log('error: ' || SQLERRM);
    x_err_flag := 'E';
```

---

## 问题汇总表

| 编号 | 严重度 | 简述 | 首次发现批次 | 当前状态 | 主要位置 |
| ---- | ------ | ---- | ------------ | -------- | -------- |

**统计**：...
**上线建议**：...
```

### 再次评审（文件已存在）

1. 读取现有文件，了解历史编号上限
2. 在"组织规则"章节之后**插入**新批次（最新在上）
3. **重写**底部汇总表，更新状态，追加新问题
4. 更新统计行

> ⚠️ **验证项也是正式条目，格式不降级**：本批次里把旧问题标 FIXED/VERIFIED 的"验证项"，与新问题一样**必须带 `**位置**：文件 L行号`**（指向修复后的实际代码行），不能写成"D.pkb 同位置""各子查询"之类的文字描述。再评审时改动文件行号会整体偏移，**行号一律去当前附件源文件 grep 实测**，不要沿用上一批次行号、也不要用 diff 里的 `@@` 偏移。汇总表"主要位置"列同样填实测行号。

## Step 8c - 行号自检（硬门槛，git commit 前必跑）

写完 CODE_REVIEW 后、commit 前，机械校验**每个问题条目（`### 编号 [级别] ...`，含 FIXED/VERIFIED 验证项）都带 `**位置**：... L<数字>`**。这一步不靠"记得加行号"，靠 grep 兜底——LOW/NIT 与验证项最易漏。有缺失则回 Step 8 补全后再 commit，不得跳过。

```bash
CR="$TARGET_DIR/CODE_REVIEW_${TICKET_ID}.md"
MISSING=$(awk '
  function flush(){ if(cur!="" && !ok) print "  - " cur }
  /^### [A-Z]+-[0-9]+/ { flush(); cur=$0; ok=0; next }            # 问题条目头
  /^(### |## |---)/    { flush(); cur=""; ok=0 }                  # 条目边界
  /^\*\*位置\*\*/ {                                               # 必须有 位置 行，且：
    if ($0 ~ /L[0-9]/ ||                                         #   命中 L行号，或
        $0 ~ /全文|全部|缺交付|未交付|无可评审|无实现|应在|N\/A/) #   显式标"无具体代码行"
      ok=1
  }
  END { flush() }
' "$CR")

if [ -n "$MISSING" ]; then
  echo "✗ 以下问题条目缺 **位置**:L行号（FIXED/验证项/LOW/NIT 同样要求），补全后再 commit："
  echo "$MISSING"
  echo "  行号去当前附件源文件 grep -an 实测，不要用 diff 偏移或旧行号；"
  echo "  确无代码可指的条目（如缺交付/整块改动），位置行需显式写"全文/缺交付/应在 XXX"等字样。"
  # 不继续 Step 9，回 Step 8 修正
else
  echo "✔ 行号自检通过：所有问题条目均带 位置(L行号 或 显式无代码标记)"
fi
```

> 豁免：①`### Migration 清单审阅` 等非"编号-序号"小节不匹配 `[A-Z]+-[0-9]+`，天然不检；②业务完整性类"无代码可指"条目（缺交付/整块），其 `**位置**` 行显式含"全文/缺交付/应在…"即放行——但**仍必须有 `**位置**` 行**，完全不写位置一律拦截。

## Step 9 - Git Commit

评审文档写入后，将代码文件和评审文档一起提交到 ticket 目录下的 git repo：

```bash
cd "$TARGET_DIR"

# 加入评审文档
git add design.md CODE_REVIEW_*.md 2>/dev/null

# 判断有无内容需要提交
if git diff --cached --quiet; then
  echo "Git: 无变更需要提交"
else
  BATCH_NUM=$(grep -c "^## 批次" CODE_REVIEW_*.md 2>/dev/null || echo "1")
  git commit -m "$TICKET_ID: 批次${BATCH_NUM} 评审（代码+文档）" \
    --author="Claude Code <noreply@anthropic.com>"
  echo "Git commit 完成"
fi
```

打印：生成/更新的文件列表，本批次新发现问题数量（按严重度），git commit hash。

## Step 10 - What Next 提示（固定末尾输出，简洁多行）

评审流程完成后，**必须**在回复末尾打印以下格式的提示（替换 TICKET_ID / 批次号 / 问题分布 等占位符为实际值）：

```
──────────────────────────────────────────────
✔ {TICKET_ID} 评审完成（批次 {N}）

SVN 基线：r{SVN_BASELINE_REV}（review 已基于此 revision）

生成产物：
  {TARGET_DIR}/CODE_REVIEW_{TICKET_ID}.md
  {TARGET_DIR}/design.md

本批次问题：{HIGH × N / MEDIUM × N / ...}
上线建议：{放行 / 条件放行 / 暂缓} — {一句话摘要}

下一步（可选）：
  1. 打开 CODE_REVIEW_{TICKET_ID}.md 人工复核内容
  2. 确认无误后：/skill:ebs-jira-review-submit {TICKET_ID}
     → 上传评审 md 到 Jira，并自动评论完成标记
  3. 评审通过后：/skill:ebs-jira-review-svn-commit {TICKET_ID}
     → 提交 SVN，回写 Migration revision，更新 Jira 附件并 @ reporter
──────────────────────────────────────────────
```

规则：
- 无论用户是否显式要求总结，Step 10 都必须输出 — 这是本 plugin 的约定，用于明确下一步操作入口
- 若本批次无新发现问题（如 "无改动确认" 批次），`本批次问题` 行可省略，其他条目保留
- 这段输出是**纯文本**，直接输出即可，不要发起交互提问

</process>

<subagent_design>

## Sub-agent 派发：可选 + 瘦身

Steps 5-8（文件分析 + 评审撰写）**默认在主 context 跑** —— 更快、更可控；用户能看清每步动作。
**仅在以下情况派 sub-agent**：
- diff 总行数 > 5000（大型 ticket，避免撑爆主 context）
- jar 解压后 XML 文件 > 50 个（OAF 大改）
- 用户在 conf 显式 `EBSJR_USE_SUBAGENT=1`

判定逻辑（Step 5 末尾算）：

```bash
TOTAL_DIFF_LINES=$(find "$TARGET_DIR/diff" -name "*.diff" 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
TOTAL_XML=$(find "$TARGET_DIR/extracted" -name "*.xml" 2>/dev/null | wc -l)
USE_SUBAGENT=0
if [ "${TOTAL_DIFF_LINES:-0}" -gt 5000 ] || [ "${TOTAL_XML:-0}" -gt 50 ] || [ "${EBSJR_USE_SUBAGENT:-0}" = "1" ]; then
  USE_SUBAGENT=1
fi
echo "→ diff 总行数=$TOTAL_DIFF_LINES, XML=$TOTAL_XML → sub-agent=$USE_SUBAGENT"
```

### 直跑模式（默认）

主 context 按 Step 6/7/8 顺序自己执行。读 `jira_issue.md` → 读 `diff/*.diff`（业务/视图）+ `diff/decl/*.diff`（声明）→ 读改动行上下文 → 写 design.md / CODE_REVIEW.md。

### Sub-agent 模式（重度场景）

只在 `USE_SUBAGENT=1` 时派。Prompt 模板（瘦身后，核心指令优先，背景信息从 ticket 目录文件里读）：

```
你是 Oracle EBS 代码评审专家。

INPUT:
  TARGET_DIR={TARGET_DIR}
  TICKET_ID={TICKET_ID}
  REVIEWER={REVIEWER}
  IS_RERUN={true|false}
  SVN_BASELINE=r{SVN_BASELINE_REV}
  STANDARDS_JSON=/tmp/ebs_jira_standards_{TICKET_ID}.json
  PLSQL_CONTEXT_JSON=/tmp/plsql_context_{TICKET_ID}.json
  PITFALLS={PLUGIN_ROOT}/reference/plsql-pitfalls.md   ← PL/SQL 高危模式清单（评审维度 b 逐类核对）

工作 — 严格按 9 步：
  1. 读 {TARGET_DIR}/jira_issue.md（需求基准，含 Jira 评论历史）
  2. 读 {TARGET_DIR}/design.md 和 {TARGET_DIR}/CODE_REVIEW_{TICKET_ID}.md（已存在则取历史编号上限 + 历史问题状态）
  3. 读 STANDARDS_JSON：把 .baseline_content 当评审 must-known 清单；.detail_paths 是按需 grep 的详细规范（PL/SQL 章节查 ATLAS 标准；EBR 章节查客制化开发要求；etc.）
  4. 读 PLSQL_CONTEXT_JSON（如有）：每个对象的 references[]（含 via_synonym 字段）+ called_by[]（本环境反查谁调用我）+ freshness.pulled_at。
     - 评 commit 时：若 changed object 的 signature 变化/删除 → 必查 called_by 是否非空 → 有 = HIGH（破坏兼容）
     - 评同义词引用：references 里 via_synonym=true 的项要看 resolved 字段判断真实对象
     - freshness.pulled_at > 24h 时，本次评审末尾要注明"PL/SQL 上下文基于 N 小时前快照"
  5. 读 {TARGET_DIR}/diff/*.diff（业务/视图，**评审重点**）
  6. 速读 {TARGET_DIR}/diff/decl/*.diff（DDL 声明，仅核对常见模板：cache N / UNIQUE / _N1 索引等；机械变更速读即可）
  7. 读 {TARGET_DIR}/extracted/*/（如有 OAF jar；按 diff 涉及的 XML 文件读）
  8. 用 Read 在源文件中按 diff 行号读前后 30 行上下文
  9. 读 /tmp/ebs_jira_evidence_{TICKET_ID}.json：found=false 时**必须**插入一条 HIGH（test_evidence 缺失 = "Approval-QA 阶段缺 dev 测试痕迹"；change_explanation 缺失 = "Validation-QA 阶段缺改动说明"）

输出 — 写两个文件：
  - {TARGET_DIR}/design.md（首次写全；再次评审追加 `## 第 N 轮补充` 小节，不重写前文）
  - {TARGET_DIR}/CODE_REVIEW_{TICKET_ID}.md（首次写全；再次评审在 `## 评审规则` 之后、`## 批次 1` 之前**插入** `## 批次 N`；末尾重写问题汇总表，合并历史问题状态：FIXED/PARTIAL/OPEN/WONTFIX/VERIFIED）

评审维度（缺一不可）：
  a. **业务完整性**：对照 jira_issue.md + design 文档，逐项确认实现到位；同一逻辑在多处出现是否全部改到（漏改 = HIGH）；改动间联动自洽
  b. **diff 质量**：业务逻辑 diff 按 PITFALLS 清单逐类核对（{PLUGIN_ROOT}/reference/plsql-pitfalls.md：A-H 实战八类 + I-L 来源蒸馏四节（Trivadis v4.4 / Feuerstein / Oracle-Base / Dev Gym）+ M 聚合专项）。重点强调：**每个新增或修改的过程调用必须对照被调签名逐参核对**（位置传参 + 隐式转换 = 编译期不报错的 CRITICAL，TE-1494 C-01 实例：LOG 第二参数 NUMBER 被传入 varchar 标记值）
  c. **规范合规**：对照 STANDARDS_JSON.baseline_content：
       - 命名违例（包未带 _PKG / 视图未带 _V / 变量缺前缀）= HIGH
       - 直接引用基表（缺 Editioning View）/ 包未声明 EDITIONABLE = CRITICAL（EBR 红线）
         - ⚠ **EBR 判定按 pitfalls §N**：只有 `非APPS的schema.<obj>`（如 `per.per_all_people_f`）才算引用基表；**裸名 / `apps.<obj>` 经 APPS 同义词解析，不判违例、也别标"缺前缀"风格 NIT**（TE-1581 N-01 误报教训）
       - 缺 WHEN OTHERS / 未 log 到 fnd_log = MEDIUM
       - SELECT * = LOW
       - 任何违例必须引用 baseline 章节锚（如 "违反 baseline > 命名标准 > 视图"）
  d. **影响半径**（PL/SQL）：对照 PLSQL_CONTEXT_JSON
       - 修改/删除 public package spec 中函数签名 + called_by 非空 = CRITICAL（破坏调用方）
       - 视图字段删/改 + 被其它视图/PKG 引用 = HIGH
       - 同义词指向变更 + via_synonym 引用方未同步 = HIGH
  e. **追溯注释**：每段新增/修改是否有 `-- TE-{TICKET_ID}` 注释；整块无标注 = LOW，个别行漏 = NIT

不要做的事（避免误报，已由 plugin 自动化处理）：
  - Migration `SUBVERSION REVISION NUMBER` 列空或未刷新：svn-commit Step 12 会自动回写，不算问题
  - Deploy Instructions 缺 `drop index/sequence` 步骤：首次发布场景不阻断
  - 任何 .idx/.seq/.syn 改动若仅是 cache N / UNIQUE / _N1 索引添加：不必逐行审

格式约束：
  - 每条问题必须含 **位置(文件 L行号) + 原始代码片段 + 修复建议代码**，缺一不算合格；**FIXED/VERIFIED 验证项与 LOW/NIT 同样要带 L行号**，不得简写。行号一律 `grep -an` 源文件实测，不用 diff 偏移/旧行号
  - 编号规则：B{N}-{级别简写}{序号}，跨批次唯一递增
  - 标题用动词短语（"FORALL 未读 SQL%BULK_EXCEPTIONS"，不是"FORALL 异常处理不当"）
  - 不要新建 _extracted_* / _svn_* 等 legacy 目录；任何由你生成的 diff 写到 diff/ 或 diff/decl/

返回（≤200 字）：本批次新发现 {CRITICAL/HIGH/MEDIUM/LOW/NIT × N}，上线建议 {放行/条件放行/暂缓}，一句话原因，文件列表。
```

> 旧版 prompt 含大量背景说明（200+ 行），实测被用户中断频繁。瘦身版让 agent 从 ticket 目录的文件里读上下文（design.md / CODE_REVIEW.md / jira_issue.md），主 context 只下传 "INPUT + 7 步骨架 + 评审维度 + 格式约束 + 不要做的事"。

sub-agent / 直跑完成后，主 context 执行 Step 9（git commit）和 Step 10（what-next 提示）。

</subagent_design>

<notes>
- 再次评审直接 /skill:ebs-jira-review-review TE-XXXX，无需额外参数
- **每个问题必须包含原始代码片段（标注行号）+ 修复后代码示例**；没有代码的问题描述不完整。**这条对所有条目无条件生效，与严重度无关、与是否 FIXED/VERIFIED 验证项无关**——LOW/NIT 和"已修复"验证项最容易被简写漏掉行号，必须同样带 `**位置**：文件 L行号`。行号取**当前附件源文件 `grep -an` 实测**，不可用文字描述、diff `@@` 偏移、或上一批次旧行号代替。
- SVN diff 是评审的定位入口，但评审视角要覆盖整体业务实现：先用 diff 找到改动范围，再从业务需求角度判断实现是否完整
- **Jira 标注检查**（NIT/LOW）：每处新增或修改的代码段应附有 `-- TE-XXXX` 标注注释，便于日后追溯；检查 diff 中的改动行是否有对应标注，遗漏的视为 NIT（注释所在行）或 LOW（整块逻辑无任何标注）
- Oracle EBS PL/SQL 高危问题：**完整清单见 plugin 内 `reference/plsql-pitfalls.md`（A-H 八类，含实战 ticket 来源，评审维度 b 必须逐类核对）**。速记版：参数错位（位置传参 VARCHAR2→NUMBER 隐式转换，TE-1494 C-01）、BULK COLLECT 分批时集合未清空（重复 INSERT）、FORALL SAVE EXCEPTIONS 未读 SQL%BULK_EXCEPTIONS、NLS_DATE_FORMAT 隐式转换、子查询缺 rownum=1、异常吞掉不重抛、并发程序 retcode 未置（失败仍 Normal）、LIKE 拼接 NULL 变量退化全匹配
- **评审中发现 pitfalls 清单外的新坑 → 当场追加到 `reference/plsql-pitfalls.md` 并标注来源 ticket**（清单维护约定见该文件头部）
- OAF MDS jar 内是 XML（VO/EO/Page 元数据），直接可读；重点看 viewObject 的 query、AM 的方法、page 的 region 定义
- Java jar 无 decompiler 时用 `javap -p {ClassName}.class` 看方法签名，对比 SVN 基线 jar 的 class 列表确认新增/删除的类和方法
- Office 文件先检查有无 skill 可读
- **Step 10 是硬性要求**，评审完成后必须打印 what-next 提示，指向 /skill:ebs-jira-review-submit 子命令
</notes>
