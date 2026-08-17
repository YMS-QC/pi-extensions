---
name: ebs-jira-review-svn-commit
description: >-
  评审通过后把 ticket 附件一次性提交 SVN，回写 Migration 的 SUBVERSION REVISION NUMBER，更新 Jira 附件并 @ reporter 评论，推动工作流状态。用法：/skill:ebs-jira-review-svn-commit TE-XXXX [--dry-run]。触发词：提交 SVN、svn commit。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: svn-commit.md
---

> **pi 迁移版**（upstream: `svn-commit.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
评审通过后端到端完成 SVN 提交与 Jira 回传，流程是单次原子动作（除 SVN commit 这一刻不可逆，commit 之后所有步骤都做"尽力而为 + 失败提示"）：

1. 读 ticket 目录的 Migration 文件（`*_Migration_{TICKET_ID}.xlsx`）→ Code Inventory 表
2. **严格双向匹配**：附件目录文件 ↔ Migration FILE NAME 列。任一边多/少 → 中止
3. 用 Migration 的 `SUBVERSION FILE` 列（剥 `Trident/xxamw/` 前缀）算每个文件的本地 SVN 目标路径
4. 跑 `svn update` 保险
5. 把附件覆盖到本地 SVN 路径；`svn status` 区分 M/?，对 ? 类自动 `svn add`
6. `svn diff` 完整预览
7. 拿 Jira ticket 的 `summary`，构造 commit message = `{TICKET_ID} {SUMMARY}`
8. **文本提问让用户确认**（commit message + 文件列表 + 即将走的目标 URL；未获明确确认不得执行 svn ci）
9. `svn ci` → 解析输出拿 `Committed revision NNNN`
10. 用 openpyxl 打开 Migration xlsx：仅更新本次提交涉及行的 D 列 = NNNN，**其他行原值不动**；按原文件名覆盖保存
11. Jira: 找 `*_Migration_{TICKET_ID}.xlsx` 类的现有附件 → DELETE → 上传更新后的 Migration（保持原文件名）
12. Jira: 添加 ADF 评论 @ reporter，含 revision、commit message、提交文件清单
13. 末尾打印汇总

每个步骤的失败处理见 Step 14 失败矩阵。
</objective>

<config>
共享 `~/.ebs_jira_review.conf`（同 review/submit）。
SVN 凭据走 auth cache。失效时**不在 agent 内自动 fallback**，由 `abort_with_auth_guidance` 函数打印 WSL 终端交互重认证命令并 exit 1，等用户在 claude 之外完成认证后回来重跑本命令（详见 svn-update 文档同名设计）。

**Migration 文件结构契约**（已在 TE-1302 / TE-1463 验证）：
- Sheet 名固定 `1. Code Inventory`
- 列：A=RICE COMPONENT / B=FILE NAME / C=TYPE / D=SUBVERSION REVISION NUMBER / E=SUBVERSION FILE
- B 列是文件名（basename，不带路径）
- D 列是纯整数（无 `r` 前缀，可能为空表示尚未提交）
- E 列是完整 SVN 路径，前缀 `Trident/xxamw/`，剥前缀就是相对 `$SVN_LOCAL_PATH` 的路径
- C 列**不可信**（TE-1302 jar 写 `java` 但路径明确指向 `mds/`）→ 一切以 E 列为准
</config>

<process>

## Step 1 - 解析参数 & 路径定位

```bash
# 加载 lib（在 source conf 之前，以便 extract_ticket_id 可用）
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

# 用 extract_ticket_id 容错（args trailing 备注被识别 + 忽略）
TICKET_ID=$(extract_ticket_id "${POS[@]}") || {
  echo "✗ 没找到合法的 ticket key（如 TE-1250）"
  echo "  用法：/skill:ebs-jira-review-svn-commit <TICKET_ID> [--dry-run]"
  exit 1
}

EXTRA_TEXT=$(printf '%s\n' "${POS[@]}" | grep -vxE "$TICKET_ID|--dry-run" | tr '\n' ' ' | sed 's/[[:space:]]*$//')
if [ -n "$EXTRA_TEXT" ]; then
  echo "ℹ 已识别 TICKET_ID=$TICKET_ID；忽略额外文本：「$EXTRA_TEXT」"
fi

[ "$DRY_RUN" = "1" ] && {
  echo "🔍 ───── DRY-RUN MODE ─────"
  echo "  不会 svn update / svn ci / 改 Migration / 改 Jira"
  echo "  仅验证 + 列计划"
  echo ""
}

# 进入 plugin 入口时清理同 ticket 的旧临时文件（避免新轮跑误读旧数据）
ebsjr_clean_tmp "$TICKET_ID"

source ~/.ebs_jira_review.conf 2>/dev/null
JIRA_WORK_DIR="${JIRA_WORK_DIR:-/mnt/c/Jira}"
# 默认 SVN 工作副本走 WSL ext4（~/svn/xxamw），不放 /mnt/c — v9fs 上 SQLite 锁不稳，wc.db 易损坏。
LOCAL_SVN="${SVN_LOCAL_PATH:-$HOME/svn/xxamw}"
TICKET_BASE="${TICKET_BASE:-$JIRA_WORK_DIR/ticket}"
TICKET_DIR="${TICKET_BASE}/${TICKET_ID}"

# 兼容已迁移前的旧路径（review skill 迁移期遗留）
if [ ! -d "$TICKET_DIR" ] && [ -d "/mnt/c/jira/${TICKET_ID}_attachments" ]; then
  TICKET_DIR="/mnt/c/jira/${TICKET_ID}_attachments"
  echo "→ 使用旧路径：$TICKET_DIR"
fi

[ ! -d "$TICKET_DIR" ] && { echo "✗ ticket 目录不存在：$TICKET_DIR；先跑 /skill:ebs-jira-review-review $TICKET_ID"; exit 1; }
[ ! -d "$LOCAL_SVN/.svn" ] && { echo "✗ $LOCAL_SVN 不是 svn 工作副本，先跑 /skill:ebs-jira-review-svn-init"; exit 1; }

SSL_CONF="$HOME/.svn-openssl.cnf"
SVN_BASE_FLAGS="--non-interactive --trust-server-cert-failures unknown-ca,cn-mismatch,expired,not-yet-valid,other"

svn_run() { OPENSSL_CONF="$SSL_CONF" svn "$@" $SVN_BASE_FLAGS; }

# auth 失败时不在 agent 内 fallback；指引用户在 WSL 终端手工重认证
abort_with_auth_guidance() {
  cat << EOF

══════════════════════════════════════════════
✗ SVN auth cache 已失效（服务器侧密码可能改了，或 cache 损坏）

要重新认证，请在 **claude 之外的 WSL 终端**里跑下面这条命令（密码全程不经过 agent）：

OPENSSL_CONF=\$HOME/.svn-openssl.cnf svn update "$LOCAL_SVN" --username CNU07LQ3

⚠ **不要**加 \`--trust-server-cert-failures\` 和 \`--non-interactive\` —— 这两个 flag 是互斥的（svn 设计），加了反而会让 svn 拒绝交互。

执行时 svn 按顺序会问 3 个问题：
  1. (R)eject, accept (t)emporarily, accept (p)ermanently? → 输 **p** 回车（永久信任过期证书）
  2. "CNU07LQ3" 的密码:                                    → 键盘输入新密码（隐藏回显）
  3. 保存未加密的密码？(yes/no):                            → 输 **yes** 回车

完成后 cert + 密码都进 cache，回到 agent 重跑 /skill:ebs-jira-review-svn-commit ${TICKET_ID} 即可。

为什么不在 claude 里自动处理？
  - agent 的 bash 子进程没有 TTY，svn 没法弹密码提示
  - 走命令行 --password 会让密码出现在 ps -ef 输出里
  - 让你在 /dev/tty 上手工输入是唯一既能认证又不暴露密码的路径
══════════════════════════════════════════════
EOF
  exit 1
}

# 三合一预检：project + assignee=我 + status ∈ {Approval-Dev, Approval-QA, Validation-QA}
PLUGIN_LIB="$HOME/.pi/agent/ebs-jira-review/lib"
source "$PLUGIN_LIB/jira_helpers.sh"
jira_preflight "$TICKET_ID"
echo "→ 预检通过：$TICKET_ID @ $EBSJR_STATUS （reporter=$EBSJR_REPORTER_NAME）"

# 决策文件校验：必须先跑过 /skill:ebs-jira-review-submit 且决策为 approve
DECISION_JSON=$(ebsjr_read_decision "$TICKET_ID" 2>/dev/null)
if [ -z "$DECISION_JSON" ]; then
  echo "✗ 未找到决策文件 .review_decision.json"
  echo "  必须先跑 /skill:ebs-jira-review-submit $TICKET_ID 并选择放行/条件放行"
  exit 1
fi
DECISION=$(echo "$DECISION_JSON" | jq -r '.decision // empty')
if [ "$DECISION" != "approve" ]; then
  echo "✗ 最近一次 submit 决策为 '$DECISION'，不允许 svn-commit"
  echo "  需要 dev 修复后重跑 /skill:ebs-jira-review-review + /skill:ebs-jira-review-submit 选放行"
  exit 1
fi
DECIDED_AT=$(echo "$DECISION_JSON" | jq -r '.decided_at // empty')
DECIDED_STATUS=$(echo "$DECISION_JSON" | jq -r '.jira_status_at_decision // empty')
echo "→ 决策有效：approve @ $DECIDED_AT (state at decision: $DECIDED_STATUS)"

# 决策时的 status 与当前 status 应一致；不一致提醒。
# 注意：DECIDED_STATUS 可能为空 —— ebsjr_write_decision 读 $EBSJR_STATUS，而 skill 分步执行时
# preflight 与 write_decision 常落在不同 Bash 调用（env 不跨调用持久），导致写入时该值为空。
# 空值 ≠ 当前状态会误判中止，所以仅在「非空且不一致」时才拦截；空值只提示不阻断。
if [ -n "$DECIDED_STATUS" ] && [ "$DECIDED_STATUS" != "$EBSJR_STATUS" ]; then
  echo "⚠ 警告：决策时状态 '$DECIDED_STATUS'，当前已变成 '$EBSJR_STATUS'"
  echo "  建议先重跑 /skill:ebs-jira-review-review + submit"
  exit 1
elif [ -z "$DECIDED_STATUS" ]; then
  echo "ℹ 决策文件未记录决策时状态（跨进程写入或旧版 submit），跳过状态一致性校验"
fi
```

## Step 1c - DRY-RUN 早退（如启用）

```bash
if [ "$DRY_RUN" = "1" ]; then
  MIG_FILE=$(ls "${TICKET_DIR}"/*_Migration_${TICKET_ID}.xlsx 2>/dev/null | grep -v '^~\$' | head -1)
  ATT_COUNT=$(find "$TICKET_DIR" -maxdepth 1 -type f \
    ! -name '_*' ! -name '.*' ! -name 'design.md' ! -name 'CODE_REVIEW_*.md' \
    ! -name 'jira_issue.md' ! -name '*.bak' \
    ! -name '*.docx' ! -name '*.doc' ! -name '*.pptx' ! -name '*.ppt' \
    ! -name '*.xlsx' ! -name '*.xls' ! -name '*.csv' \
    ! -name '*.pdf' \
    ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.gif' ! -name '*.bmp' ! -name '*.emf' \
    | wc -l)
  CUR_REV=$(svn_run info "$LOCAL_SVN" 2>/dev/null | awk -F': ' '/^Revision: |^版本: /{print $2; exit}')

  echo "──────────────────────────────────────────────"
  echo "[DRY-RUN] 计划"
  echo "  Ticket:        $TICKET_ID"
  echo "  Ticket 目录:   $TICKET_DIR"
  echo "  Migration:     $MIG_FILE"
  echo "  附件文件数:    $ATT_COUNT"
  echo "  SVN 工作副本:  $LOCAL_SVN（当前 r${CUR_REV}）"
  echo ""
  echo "  将要执行（如非 dry-run）："
  echo "    1. 解析 Migration 'Code Inventory' sheet → 文件清单"
  echo "    2. 严格双向匹配（附件 ↔ Migration），不一致即停"
  echo "    3. svn update（同步基线，可能触发 abort_with_auth_guidance）"
  echo "    4. cp 附件到 SVN 工作副本，svn add 新文件"
  echo "    5. svn diff 预览，文本二次确认"
  echo "    6. svn ci → 拿 NEW_REV"
  echo "    7. openpyxl 改 Migration 涉及行 D 列 = NEW_REV"
  echo "    8. Jira: DELETE 旧 Migration → 上传新 Migration → @reporter 评论"
  echo "──────────────────────────────────────────────"
  exit 0
fi
```

## Step 2 - 解析 Migration 文件

定位 `${TICKET_DIR}/*_Migration_${TICKET_ID}.xlsx`（应有且仅有一个）：

```bash
MIG_FILE=$(ls "${TICKET_DIR}"/*_Migration_${TICKET_ID}.xlsx 2>/dev/null | grep -v '^~\$' | head -1)
[ -z "$MIG_FILE" ] && { echo "✗ 未找到 Migration 文件：${TICKET_DIR}/*_Migration_${TICKET_ID}.xlsx"; exit 1; }
echo "→ Migration: $MIG_FILE"
```

用 openpyxl 读 `1. Code Inventory` sheet，输出到 `/tmp/svn_inv_${TICKET_ID}.tsv`，每行：
```
file_name<TAB>svn_relative_path<TAB>current_revision<TAB>row_index
```

`svn_relative_path` 取 E 列剥 `Trident/xxamw/` 前缀；找不到前缀 → 报错。`row_index` 是 1-based xlsx 行号（用于 Step 11 回写）。

```python
# 在 Bash 内嵌 python3 << 'EOF'
from openpyxl import load_workbook
import sys, os

wb = load_workbook(os.environ['MIG_FILE'], data_only=False)
if '1. Code Inventory' not in wb.sheetnames:
    print("MISSING_SHEET", file=sys.stderr); sys.exit(1)

ws = wb['1. Code Inventory']
out = []
for idx, row in enumerate(ws.iter_rows(min_row=2, values_only=False), start=2):
    fname = row[1].value     # B
    rev   = row[3].value     # D
    spath = row[4].value     # E
    if not fname or not spath:
        continue
    if not str(spath).startswith('Trident/xxamw/'):
        print(f"BAD_PATH row={idx} fname={fname} spath={spath}", file=sys.stderr); sys.exit(2)
    rel = str(spath)[len('Trident/xxamw/'):]
    out.append(f"{fname}\t{rel}\t{rev or ''}\t{idx}")

with open(os.environ['INV_TSV'], 'w') as f:
    f.write('\n'.join(out) + '\n')
print(f"OK rows={len(out)}")
EOF
```

## Step 3 - 列出附件目录的代码文件

排除：`design.md` / `CODE_REVIEW_*.md` / `jira_issue.md` / `~$*.xlsx` / `*.bak` / `_extracted_*` / `_svn_*` / `.git/` / 任何 `*_Migration_*.xlsx`（migration 自身不进 SVN）。

```bash
# maxdepth 1：不递归进解压目录
# `_*` / `.*` 前缀全部排除：review skill 的中间产物（_svn_diff_*.txt / _batch_diff_*.txt / _extracted_* 之类）
# 以及 .gitignore 等隐藏文件都不进 SVN。开发者交付物绝不会以 `_` 或 `.` 开头。
find "$TICKET_DIR" -maxdepth 1 -type f \
  ! -name '_*' \
  ! -name '.*' \
  ! -name 'design.md' \
  ! -name 'CODE_REVIEW_*.md' \
  ! -name 'jira_issue.md' \
  ! -name '~$*' \
  ! -name '*.bak' \
  ! -name '*.docx' ! -name '*.doc' ! -name '*.pptx' ! -name '*.ppt' \
  ! -name '*.xlsx' ! -name '*.xls' ! -name '*.csv' \
  ! -name '*.pdf' \
  ! -name '*.png' ! -name '*.jpg' ! -name '*.jpeg' ! -name '*.gif' ! -name '*.bmp' ! -name '*.emf' \
  | sort > /tmp/svn_att_${TICKET_ID}.txt
```

> 注：附件目录常残留 review 阶段下载的**非代码附件**——MD070 设计文档（`.docx`）、迁移/技术清单（`.xlsx`）、需求截图（`.png`/`.emf` 等）。这些**一律不进 SVN**，Code Inventory 也不会列。按**扩展名通排** office/图片/pdf（不再靠具体文件名），避免每次有新图文附件就漏挡、把 Step 4 严格匹配卡在"附件多余"。代码 / DDL / jar / BIP 模板（`.pkb/.pks/.sql/.tbl/.prc/.fnc/.trg/.vw/.syn/.jar/.xml/.rtf/.wft` 等）不在排除名单，正常留下交给 Step 4 与 Migration 对账。**漏网的复测/证据文件**（如 `xxx.复测xml.xml`、命名含 复测/retest/output/结果）也由 Step 4 的 `extra_evidence` 分类放行，不会卡死匹配。
>
> 兜底：万一某扩展名误排了真交付物，它会从附件侧消失但仍在 Migration 清单 → Step 4 报 `missing_in_dir` 中止（不会静默漏提），安全。

## Step 4 - 严格双向匹配（你定的"严重错误"）

```python
import os, re, sys

# 读 inv tsv 和 att txt
inv_basenames = {line.split('\t')[0] for line in open(INV_TSV)}
att_basenames = {os.path.basename(p) for p in open(ATT_TXT).read().splitlines()}

missing_in_dir = inv_basenames - att_basenames    # Migration 列了但附件没传 —— 永远中止
extra_in_dir   = att_basenames - inv_basenames    # 附件传了但 Migration 没列 —— 要分类

# 代码交付扩展名（与 Step 3 注释一致）：这些才是"漏列入 Migration"的高风险对象
CODE_EXT = {'.pks','.pkb','.sql','.tbl','.prc','.fnc','.trg','.vw','.mvw',
            '.syn','.seq','.idx','.jar','.wft','.rtf','.xml'}
# 证据/复测产物文件名特征（.xml 复测 dump、测试输出等命名）。命中 = 非交付物，不进 SVN
EVIDENCE_RE = re.compile(r'(复测|retest|测试结果|验证结果|验证|output|result|结果|截图|sample|example|dump)', re.I)

extra_deliverable = set()   # 高风险：代码扩展名 + 非证据命名 —— 中止
extra_evidence     = set()  # 证据/非代码：截图复测等 —— 警告并放行（不进 SVN，由 INV 驱动天然排除）
for f in extra_in_dir:
    ext = os.path.splitext(f)[1].lower()
    if ext in CODE_EXT and not EVIDENCE_RE.search(f):
        extra_deliverable.add(f)
    else:
        extra_evidence.add(f)

# ① missing_in_dir：Migration 列了但没传 —— 永远中止（漏交付）
# ② extra_deliverable：附件多了代码交付物但 Migration 没列 —— 中止（漏列清单）
if missing_in_dir or extra_deliverable:
    print("✗ Migration ↔ 附件不一致，必须先对齐:")
    if missing_in_dir:
        print(f"  Migration 里列了但附件目录没传 ({len(missing_in_dir)}):")
        for f in sorted(missing_in_dir): print(f"    - {f}")
    if extra_deliverable:
        print(f"  附件目录里多了代码交付物但 Migration 没列 ({len(extra_deliverable)}):")
        for f in sorted(extra_deliverable): print(f"    - {f}")
    print("")
    print("处理建议:")
    print("  - 是开发者忘了更新 Migration → 让开发者补 Migration 后重新走 review")
    print("  - 是开发者多传/漏传文件 → 让开发者补/删后重新走 review")
    sys.exit(1)

# ③ extra_evidence：复测/截图/非代码附件 —— 不中止，只提示（这些本就不该进 SVN/Migration）
if extra_evidence:
    print(f"ℹ 识别到 {len(extra_evidence)} 个非交付附件（复测/截图/证据等），不进 SVN，已跳过：")
    for f in sorted(extra_evidence): print(f"    - {f}")
    print("  （提交以 Migration Code Inventory 为准，上述文件天然不进 SVN）")
```

**判定规则**（保留"漏交付/漏清单必中止"的硬约束，同时不再被证据文件误卡）：
- `missing_in_dir`（Migration 列了没传）→ **必中止**（漏交付，serious error）
- `extra_deliverable`（附件多了代码交付物未列入 Migration）→ **必中止**（漏列清单，serious error）
- `extra_evidence`（复测 dump / 截图 / 非代码扩展名 / 文件名含"复测/retest/output/结果"等）→ **只提示不中止**（这些本就不该进 SVN，提交以 Migration Code Inventory 为准，天然排除）

> 来源 TE-1581：`adhoc approver字段.复测xml.xml` 是 DEV 复测产物（运行时报告输出 XML，证 adhoc_approver=`Wu, Cecilia（CN011981）`），`.xml` 扩展名命中 CODE_EXT 但文件名含"复测"→ 归 `extra_evidence` 放行。真正的 BIP 模板（如 `XXR2REXT8058_GBL.xml`，RICEW 命名、无证据特征）若漏列仍会进 `extra_deliverable` 中止，安全不失。

## Step 5 - svn update（保险刷一次）

用 lib 的 `svn_retry`：网络抖动自动重试，auth/conflict 立即停（返回码区分）。

```bash
echo "→ 同步 SVN 工作副本到最新..."
UPD=$(svn_retry "svn update" svn update "$LOCAL_SVN" 2>&1)
UPD_RC=$?
echo "$UPD" | tail -5

case $UPD_RC in
  0) : ;;
  2) abort_with_auth_guidance ;;
  3) echo "✗ 工作副本冲突，先 resolve 再来"; exit 1 ;;
  *) echo "✗ svn update 失败（RC=$UPD_RC）"; exit 1 ;;
esac

UPDATED_REV=$(svn_run info "$LOCAL_SVN" | awk -F': ' '/^版本: |^Revision: /{print $2; exit}')
echo "→ 当前基线 r${UPDATED_REV}"
```

## Step 6 - 拷贝附件到 SVN 工作副本

```bash
# 从 inv tsv 逐行处理：file_name <TAB> svn_relative_path
while IFS=$'\t' read -r FNAME SREL CURREV ROW; do
  SRC="${TICKET_DIR}/${FNAME}"
  DST="${LOCAL_SVN}/${SREL}"
  DST_DIR=$(dirname "$DST")

  [ ! -f "$SRC" ] && { echo "✗ 源文件丢了: $SRC"; exit 1; }

  # 确保目标父目录存在（svn 子目录如 sql/ mds/ 必然存在；若不存在说明 Migration E 列写错）
  if [ ! -d "$DST_DIR" ]; then
    echo "✗ SVN 目标父目录不存在: $DST_DIR"
    echo "  Migration 第 $ROW 行的 SUBVERSION FILE 列可能错了"
    exit 1
  fi

  # 行尾归一化（关键）：dev 编辑器常把文件存成 LF，而本仓库（Windows 双轨维护）基线是 CRLF。
  # 盲 cp 会让 svn diff 把"每一行"都当改动（TE-1581：直接 cp → 14877 行 churn；归一化 → 52 行真实改动）。
  # 策略：以 SVN 既有文件（DST）的行尾风格为准，把附件归一化到一致；新文件无基线则原样。
  #   二进制（jar/class/图片/office）行尾无意义，一律 cp 原样。
  case "$FNAME" in
    *.jar|*.class|*.png|*.jpg|*.jpeg|*.gif|*.bmp|*.emf|*.pdf|*.xls|*.xlsx|*.doc|*.docx|*.ppt|*.pptx)
      cp -p "$SRC" "$DST"
      echo "  cp $FNAME → $SREL（二进制，原样）"
      ;;
    *)
      if [ -f "$DST" ]; then
        if grep -q $'\r' "$DST" && ! grep -q $'\r' "$SRC"; then
          sed 's/$/\r/' "$SRC" > "$DST"      # 基线 CRLF + 附件 LF → 转 CRLF
          echo "  cp $FNAME → $SREL（LF→CRLF 归一化，对齐基线）"
        elif ! grep -q $'\r' "$DST" && grep -q $'\r' "$SRC"; then
          tr -d '\r' < "$SRC" > "$DST"       # 基线 LF + 附件 CRLF → 转 LF
          echo "  cp $FNAME → $SREL（CRLF→LF 归一化，对齐基线）"
        else
          cp -p "$SRC" "$DST"                # 行尾已一致
          echo "  cp $FNAME → $SREL"
        fi
      else
        cp -p "$SRC" "$DST"                  # 新文件（首次 svn add）：无基线可对齐，原样
        echo "  cp $FNAME → $SREL（新文件）"
      fi
      ;;
  esac
done < /tmp/svn_inv_${TICKET_ID}.tsv
```

> **为什么必须归一化**：仓库无 `svn:eol-style` 属性，SVN 不自动转换行尾。dev 在 Windows/IDE 里编辑保存常产 LF，而 `~/svn/xxamw` 与 `C:\svn\xxamw` 双轨维护的基线是 CRLF。直接 cp 会让提交包含"删 \r 加回"的整文件 churn，淹没真实改动、污染历史、增大冲突面。归一化后 diff 只剩业务改动。二进制类型显式跳过（sed/tr 会损坏）。

## Step 7 - svn status 分类 + svn add 新文件

```bash
# 只对本次涉及的路径跑 status，避免被工作副本里其它脏文件干扰
TARGET_PATHS=$(awk -F'\t' -v base="$LOCAL_SVN" '{print base "/" $2}' /tmp/svn_inv_${TICKET_ID}.tsv)

STATUS_OUT=$(svn_run status $TARGET_PATHS 2>&1)
echo ""
echo "── svn status ──"
echo "$STATUS_OUT"

# ? = unversioned，需要 svn add
# 注意：svn_run 是 bash 函数，不能用 `xargs svn_run`（xargs 子进程看不到函数，会报
# `xargs: svn_run: 没有那个文件或目录`）。用 while-read 在当前 shell 内逐个调用。
UNVERSIONED=$(echo "$STATUS_OUT" | awk '$1=="?"{print $2}')
if [ -n "$UNVERSIONED" ]; then
  echo ""
  echo "→ svn add 新文件:"
  while IFS= read -r f; do
    [ -n "$f" ] && svn_run add "$f"
  done <<< "$UNVERSIONED"
fi

# 重新跑一次 status 确认所有目标文件都是 M 或 A
FINAL_STATUS=$(svn_run status $TARGET_PATHS 2>&1)
INVALID=$(echo "$FINAL_STATUS" | awk '$1!="M" && $1!="A" && $1!=""{print}')
if [ -n "$INVALID" ]; then
  echo "✗ 存在异常状态文件，无法继续："
  echo "$INVALID"
  exit 1
fi

# 早退：拷贝完后没 M/A 表示附件和 SVN 现状一致 — 无变更可提交
# （多发生在：开发者重传了同 md5 的文件、或 ticket 已经走过 svn-commit 又来跑一次）
if [ -z "$(echo "$FINAL_STATUS" | tr -d '[:space:]')" ]; then
  echo ""
  echo "──────────────────────────────────────────────"
  echo "ℹ 附件与 SVN 当前内容完全一致（md5 无差异）"
  echo "  没有可提交的变更；本次 svn-commit 不会调用 svn ci"
  echo ""
  echo "  如果你期望有变更，检查："
  echo "    - 开发者是否真的重传了新版本"
  echo "    - Migration 的 SUBVERSION FILE 列指向的是不是正确的目标路径"
  echo "──────────────────────────────────────────────"
  exit 0
fi
```

## Step 8 - svn diff 完整预览

```bash
echo ""
echo "════════════ SVN DIFF ════════════"
svn_run diff $TARGET_PATHS | head -500
echo "════════════════════════════════════"
```

> 二进制文件（`.jar`）svn diff 显示 `Cannot display: file marked as a binary type.` —— 正常，文本部分会有完整 diff。

## Step 9 - 取 Jira summary 构造 commit message

```bash
ISSUE_JSON=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID?fields=summary,reporter")

SUMMARY=$(echo "$ISSUE_JSON" | jq -r '.fields.summary // empty')
REPORTER_ID=$(echo "$ISSUE_JSON" | jq -r '.fields.reporter.accountId // empty')
REPORTER_NAME=$(echo "$ISSUE_JSON" | jq -r '.fields.reporter.displayName // empty')

[ -z "$SUMMARY" ] && { echo "✗ 取不到 ticket summary（检查 token 权限）"; exit 1; }

COMMIT_MSG="${TICKET_ID} ${SUMMARY}"
echo "→ Commit message: $COMMIT_MSG"
```

## Step 10 - 显示预览，文本提问确认

构造预览文本：

```
══════════════ 即将提交 SVN ══════════════
仓库:        {SVN_REPO_URL}
本地副本:    {LOCAL_SVN}（已同步至 r{UPDATED_REV}）

Commit message:
  {COMMIT_MSG}

文件清单 ({N} 个):
  M  sql/XXR2REXT8058A.pkb       ← 修改
  M  sql/XXR2REXT8058A.pks
  A  mds/D2D_EXT_8043_GBL_TE-1302.jar  ← 新增

完整 diff 见上方 SVN DIFF 段。

提交后将自动:
  1. 回写 Migration 文件中本次 {N} 个文件那 {N} 行的 SUBVERSION REVISION NUMBER
  2. 删除 Jira 上现有的同名 Migration 附件，上传更新后的版本
  3. @{REPORTER_NAME} 添加评论说明已上 SVN（含 revision + 文件清单）
══════════════════════════════════════════════
```

以文本向用户确认（输出预览与下列选项后停下等待回复，未获明确确认不得执行 svn ci）：

```
问题: 确认执行 SVN 提交？提交一旦推送即不可撤销。
选项:
  1. 确认提交（推荐）         → 进入 Step 11
  2. 取消                     → exit 0，本地副本拷贝过去的文件用 svn revert 回滚
```

**取消分支**：

```bash
echo "→ 用户取消，回滚本地工作副本中本次涉及的文件..."
svn_run revert -R $TARGET_PATHS
# 对于已 svn add 但又被 revert 的新文件，文件本身还在工作副本里（unversioned）；干净点的话可以删掉
echo "$UNVERSIONED" | xargs -r rm -f
echo "✔ 已回滚，未提交"
exit 0
```

## Step 11 - 执行 svn commit（不可逆点）

用 lib 的 `svn_retry` 包裹：网络超时 / 连接问题自动重试 3 次（间隔 5s），auth / conflict 立即停。
**实测必要性**：TE-1250 svn-commit 第一次 `E170013 / E000110 连接超时`，第二次成功 — `svn_retry` 让 plugin 在网络抖动下不需要用户重跑整个命令。

```bash
# commit message 含中文，用 -F /tmp/file 比 -m 更稳
echo "$COMMIT_MSG" > /tmp/svn_commit_msg_${TICKET_ID}.txt

# svn_retry 已加 OPENSSL_CONF + --non-interactive + --trust-server-cert-failures，不要重复传
CI_OUT=$(svn_retry "svn commit" svn commit $TARGET_PATHS -F /tmp/svn_commit_msg_${TICKET_ID}.txt 2>&1)
RC=$?
echo "$CI_OUT"

case $RC in
  0) : ;;          # 成功
  2) abort_with_auth_guidance ;;
  3) echo "✗ 工作副本冲突，先解决再重跑"; exit 1 ;;
  *) echo "✗ commit 失败（RC=$RC），见上方输出"; exit 1 ;;
esac

# 解析 "Committed revision NNNN." 或 中文 "提交后的版本为 NNNN."
NEW_REV=$(echo "$CI_OUT" | grep -oE "(Committed revision|提交后的版本为) [0-9]+" | grep -oE "[0-9]+" | head -1)

if [ -z "$NEW_REV" ]; then
  echo "✗ commit 输出未含 revision，可能失败"
  echo "$CI_OUT"
  exit 1
fi

echo "✔ SVN 提交成功，新 revision: r${NEW_REV}"

# 立即清缓存，让下游读到最新状态（assignee/transition 操作不会看到 stale 缓存）
jira_state_invalidate "$TICKET_ID"
```

**Step 11 之后所有步骤都是 best-effort**：每步独立 try/catch，挂掉只 log + 提示用户手动补，不试图回滚 SVN（不可能）。

## Step 12 - 回写 Migration 文件

> **改 .xlsx 一律用 Node.js exceljs，不用 Python openpyxl** —— openpyxl `save()` 会弄坏带样式/合并单元格/图表的 Migration 文件（用户实测踩坑）。exceljs `readFile`→改 D 列→`writeFile` 原名覆盖，保留原表样式与其它 sheet。
>
> exceljs 通常装在全局（`npm ls -g exceljs`）；require 默认路径找不到时用 `NODE_PATH=$(npm root -g)` 指过去。若未装：`npm i -g exceljs`。

```bash
# 读本次 commit 涉及的 row_index（INV_TSV 第 4 列），逗号拼成 ROWS 传给 node
ROWS=$(cut -f4 "$INV_TSV" | grep -E '^[0-9]+$' | paste -sd, -)
export MIG_FILE NEW_REV ROWS
NODE_PATH=$(npm root -g); export NODE_PATH

node << 'EOF'
const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(process.env.MIG_FILE);
  const ws = wb.getWorksheet('1. Code Inventory');
  if (!ws) { console.error('✗ 无 1. Code Inventory sheet'); process.exit(1); }
  const rev  = parseInt(process.env.NEW_REV, 10);
  const rows = process.env.ROWS.split(',').map(Number);
  let n = 0;
  for (const r of rows) { ws.getRow(r).getCell(4).value = rev; n++; }  // D 列 = 4
  await wb.xlsx.writeFile(process.env.MIG_FILE);                       // 原文件名覆盖
  console.log(`✔ exceljs 回写 ${n} 行 SUBVERSION REVISION NUMBER = ${rev}`);
  console.log('  其它行的 D 列保持原值不动');
})().catch(e => { console.error('✗ exceljs 回写失败:', e.message); process.exit(1); });
EOF
```

> 校验（可选）：再 `readFile` 打印涉及行的 B/D 列确认。注意 DDL 等单元格若是富文本/超链接对象，B 列读出来是 `[object Object]`（正常，值未损坏）；D 列写的是纯数字不受影响。

**关键不变量**：只改 `target_rows` 这几行的 D 列；其它行（包括之前轮次填过的）一概不动。

### Step 12b - 把 Migration 改动落入 ticket 目录的 git 历史

Migration xlsx 是 binary，**不入 SVN** —— 但本地 ticket 目录的 git 是评审审计依据，需要记录"r1402 这次提交后 Migration 被回写过"。

```bash
if [ -d "${TICKET_DIR}/.git" ]; then
  (
    cd "$TICKET_DIR"
    # Migration xlsx 默认被 .gitignore 排除（review skill 初始化时写的规则）
    # 用 -f 强制 add，让本次回写进 git 历史
    git add -f "$(basename "$MIG_FILE")" 2>/dev/null

    if ! git diff --staged --quiet; then
      git commit -m "${TICKET_ID}: Migration 回写 SUBVERSION REVISION = ${NEW_REV}（svn-commit）" \
        --author="Claude Code <noreply@anthropic.com>" 2>/dev/null \
        && echo "✔ 本地 git 已记录 Migration 回写"
    fi
  )
fi
```

## Step 13 - Jira 附件先删后传 + 评论

### 13a. 找到 Jira 上现有的同名 Migration 附件并 DELETE

```bash
ATT_LIST=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID?fields=attachment")

MIG_BASENAME=$(basename "$MIG_FILE")

# 找出名字 = MIG_BASENAME 的所有 attachment id（可能有多个：如果之前手动传过）
OLD_IDS=$(echo "$ATT_LIST" | jq -r --arg name "$MIG_BASENAME" \
  '.fields.attachment[]? | select(.filename == $name) | .id')

for AID in $OLD_IDS; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    -X DELETE "$JIRA_BASE_URL/rest/api/3/attachment/$AID")
  if [ "$HTTP_CODE" = "204" ]; then
    echo "✔ 删除旧 Migration 附件 id=$AID"
  else
    echo "⚠ 删除附件 $AID 失败 (HTTP $HTTP_CODE)；继续上传新版本"
  fi
done
```

### 13b. 上传更新后的 Migration（保持原文件名）

```bash
ATT_RESP=$(curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -X POST \
  -H "X-Atlassian-Token: no-check" \
  -F "file=@${MIG_FILE};filename=${MIG_BASENAME}" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/attachments")

NEW_ATT_ID=$(echo "$ATT_RESP" | jq -r '.[0].id // empty')
NEW_ATT_URL=$(echo "$ATT_RESP" | jq -r '.[0].content // empty')

if [ -z "$NEW_ATT_ID" ]; then
  echo "⚠ 上传新 Migration 失败：$ATT_RESP"
  echo "  SVN 已提交（r$NEW_REV），Migration 已回写本地（$MIG_FILE）"
  echo "  请手动到 Jira 上传 $MIG_BASENAME"
fi
```

### 13c. ADF 评论（@reporter + revision + 提交清单）

> 评论格式遵循 submit.md 的 ADF 规范（v3 + ADF），由 Claude 用 Write 工具构造 `/tmp/svn_comment_${TICKET_ID}.json`，再 curl 发送。

ADF 文档结构（按顺序）：

| # | 段类型 | 内容 |
|---|---|---|
| 1 | mention 段 | `@{REPORTER_NAME}`（reporter accountId） |
| 2 | 提交说明 | `代码已提交 SVN，revision ` + code(`r${NEW_REV}`) + `。` |
| 3 | commit message | `Commit: ` + code(`{COMMIT_MSG}`) |
| 4 | 清单标题 | `提交清单（{N} 个文件）：` |
| 5 | bulletList | 每行一个文件，格式：`code({M/A})` + ` ` + `text({svn_relative_path})` |
| 6 | Migration 提示 | `Migration 文件已回写 revision 并重新上传至本 ticket。` |

**ADF 节点示例**（commit 段）：
```json
{ "type": "paragraph", "content": [
  { "type": "text", "text": "代码已提交 SVN，revision " },
  { "type": "text", "text": "r1390", "marks": [{"type": "code"}] },
  { "type": "text", "text": "。" }
]}
```

**列表项示例**：
```json
{ "type": "listItem", "content": [{
  "type": "paragraph", "content": [
    { "type": "text", "text": "M", "marks": [{"type": "code"}] },
    { "type": "text", "text": " sql/XXR2REXT8058A.pkb" }
  ]
}]}
```

发送：

```bash
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/svn_comment_${TICKET_ID}.json \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/comment"
```

如评论失败：打印警告（SVN 已提交、Migration 已回传，仅缺评论），让用户手动补即可。

## Step 13d - 推动 Jira 工作流（按当前状态分支）

按 `EBSJR_STATUS`（Step 1 预检时拿到，已存活在 env 里）决定状态转移和经办人变更：

| 当前状态 | 目标状态 | 新 assignee | transition 名 |
|---|---|---|---|
| `Approval - Dev` | `Deployment - Dev` | reporter (`EBSJR_REPORTER_ID`) | `Deployment - Dev` |
| `Approval - QA` | `Deployment - QA` | DBA (`DBA_ACCOUNT_ID`) | `Deployment - QA` |
| `Validation - QA` | **不变** | DBA (`DBA_ACCOUNT_ID`) | （仅改 assignee，不调 transition）|

```bash
case "$EBSJR_STATUS" in
  "Approval - Dev")
    TARGET_STATE="Deployment - Dev"
    NEW_ASSIGNEE_ID="$EBSJR_REPORTER_ID"
    NEW_ASSIGNEE_NAME="$EBSJR_REPORTER_NAME"
    DO_TRANSITION=1
    ;;
  "Approval - QA")
    TARGET_STATE="Deployment - QA"
    NEW_ASSIGNEE_ID=$(ebsjr_resolve_dba_id)
    NEW_ASSIGNEE_NAME="${DBA_ACCOUNT_NAME:-DBA}"
    DO_TRANSITION=1
    ;;
  "Validation - QA")
    TARGET_STATE=""
    NEW_ASSIGNEE_ID=$(ebsjr_resolve_dba_id)
    NEW_ASSIGNEE_NAME="${DBA_ACCOUNT_NAME:-DBA}"
    DO_TRANSITION=0
    ;;
esac

# transition（如有）
if [ "$DO_TRANSITION" = "1" ]; then
  TID=$(jira_transition_id "$TICKET_ID" "$TARGET_STATE")
  if [ -n "$TID" ]; then
    if jira_do_transition "$TICKET_ID" "$TID"; then
      echo "✔ 状态推动：$EBSJR_STATUS → $TARGET_STATE (transition id=$TID)"
    else
      echo "⚠ 状态推动失败（SVN 已提交，需手动到 Jira 改状态到 $TARGET_STATE）"
    fi
  else
    echo "⚠ 在 $EBSJR_STATUS 下找不到通往 $TARGET_STATE 的 transition；手动改"
  fi
fi

# 改 assignee
if [ -z "$NEW_ASSIGNEE_ID" ]; then
  echo "⚠ 未解析到新 assignee accountId（QA 阶段需 DBA_ACCOUNT_NAME/ID 配置）"
else
  if jira_assign "$TICKET_ID" "$NEW_ASSIGNEE_ID"; then
    echo "✔ Assignee 改派：$EBSJR_ASSIGNEE_NAME → $NEW_ASSIGNEE_NAME"
  else
    echo "⚠ 改 assignee 失败（手动到 Jira 改派给 $NEW_ASSIGNEE_NAME）"
  fi
fi

# 决策文件本次任务已用完，归档（保留追溯，加时间戳后缀）
DEC_FILE=$(ebsjr_decision_file "$TICKET_ID")
if [ -f "$DEC_FILE" ]; then
  mv "$DEC_FILE" "${DEC_FILE}.committed_$(date +%Y%m%d-%H%M%S)"
fi
```

> Step 13d 全部 best-effort：SVN ci 已成功（不可逆），workflow 推动失败不退出 1，只打 ⚠ 警告并提示手动操作。

## Step 14 - 失败矩阵（Step 11 之前 vs 之后）

| 阶段 | 失败 | 行为 |
| --- | --- | --- |
| 1-10 | Migration ↔ 附件不匹配 | 中止，要求开发者对齐 |
| 5    | svn update 冲突 | 中止，让用户人工 resolve |
| 5    | auth cache 失效 | 打印 WSL 终端交互重认证命令，exit 1（用户在 claude 外完成认证后重跑本命令）|
| 7    | svn status 出现 ! / D 等异常 | 中止 |
| 10   | 用户选择取消 | svn revert + 删 unversioned 拷贝，退出 |
| 11   | svn ci 网络/auth 失败 | 中止；本地工作副本保留拷贝（用户可重跑） |
| **11**   | **svn ci 成功（不可逆点）** | **此后只前进** |
| 12   | xlsx 写失败 | 警告：SVN 已提交 r{N}，Migration 未回写；让用户手动改 |
| 13a  | 删旧附件失败 | 警告，继续 13b（Jira 会出现两个同名附件） |
| 13b  | 上传新附件失败 | 警告，提示用户手动上传更新后的 Migration |
| 13c  | 发评论失败 | 警告，提示用户手动评论 |

**Step 11 之后任何失败都不退出 1**，全部 best-effort 跑完后再 exit 0，避免出现"提交了但用户以为失败"的歧义。

## Step 15 - 末尾输出

```
──────────────────────────────────────────────
✔ {TICKET_ID} 已提交 SVN

SVN:        r{NEW_REV}（{COMMIT_MSG}）
文件:       {N} 个（M × {modCount}, A × {addCount}）
Migration:  本地已回写、Jira 附件已替换
评论:       {JIRA_BASE_URL}/browse/{TICKET_ID}?focusedId={COMMENT_ID}
@reporter:  {REPORTER_NAME}

如需查看：{JIRA_BASE_URL}/browse/{TICKET_ID}
──────────────────────────────────────────────
```

如果某些步骤 best-effort 失败，相应行打 `⚠ 需手动处理：xxx`。

</process>

<notes>
- **多轮 review 语义**（你的 Q7）：开发者改完重传 → CR 重启 → 第二次 svn-commit。本命令每次只动**本次涉及行**的 D 列，**前轮已填的 revision 保留不动**。所以 Migration 文件里同时存在多个 revision 完全正常（TE-1302 实样：1253/1375/1377/1378 共存）
- **Migration 文件命名匹配**：`*_Migration_${TICKET_ID}.xlsx`。开发者重传 Migration 时如果改了前缀（如 `R2R_EXT_8058_GBL_Migration_TE-1302_v2.xlsx`）会匹配不到，本命令会报错并停下；不主动模糊匹配，避免误判
- **附件目录里允许有 design.md / CODE_REVIEW_*.md / *_Code_Review.xlsx 等评审产物**：Step 3 已通过排除规则跳过；这些文件不进 SVN 也不进 Migration
- **OAF/MDS jar 是新增（A）而非修改（M）**：每个 ticket 一个独立命名的 jar（`{RICEW}_TE-{N}.jar`），`mds/` 累加保留所有历史版本。所以 `svn status` 第一次跑会看到 `?`，本命令 Step 7 自动 `svn add`
- **PL/SQL 文件是修改（M）**：基线名固定（`XXR2REXT8058A.pkb`），多次 ticket 修改同一文件，`svn status` 直接出 M
- **commit author = 你（CNU07LQ3）**：来自 SVN auth cache 中的 username。SVN 历史里会显示 `CNU07LQ3` 而不是 `claude code`
- **commit message 用 -F file 不用 -m**：避免中文 + shell 字符串转义问题
- **二进制 jar diff**：svn diff 对 jar 报"file marked as binary"，正常；review skill 已经在前置步骤解压并对比 XML 元数据，本命令不重复
- **Step 13 整个 Jira 段如果失败**：SVN 已是事实状态，Jira 评论 / 附件都可以人工补；优先保证 Step 11 的原子性
- **不写 git commit**：本命令的产物（Migration 回写）已经在 SVN 里了，不需要重复在 ticket 目录的 git 里记录
</notes>
