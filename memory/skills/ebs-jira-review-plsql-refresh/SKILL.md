---
name: ebs-jira-review-plsql-refresh
description: >-
  把 ticket 涉及的 PL/SQL 对象（及一阶依赖、同义词）的最新源码从指定环境拉到本地，构建评审上下文。用法：/skill:ebs-jira-review-plsql-refresh TE-XXXX [env]。触发词：plsql 上下文、刷新 PL/SQL 对象。
metadata:
  source: jimmy-local/ebs-jira-review
  upstream: plsql-refresh.md
---

> **pi 迁移版**（upstream: `plsql-refresh.md` @ jimmy-local/ebs-jira-review）。共享资产：`~/.pi/agent/ebs-jira-review/`（`lib/`、`reference/`），配置仍用 `~/.ebs_jira_review.conf`。
> pi 约定：交互确认一律「输出预览/选项 → 文本提问 → 停下等用户回复」，未获答复不得继续后续步骤；认证类交互（svn 密码）提示用户在 agent 之外的终端手工执行。


<objective>
针对一个 ticket，把 SVN 提交涉及的 PL/SQL 对象（PACKAGE / VIEW / TABLE / SYNONYM 等）从指定环境（dev/qa/pd）拉最新源码到本地缓存，并解析同义词指向。这样 `/skill:ebs-jira-review-review` 后续做 PL/SQL 评审时有充足的本地上下文：

1. 每个被修改对象**引用了**哪些下游对象（references）
2. 每个被修改对象**被谁调用**（called_by，从本环境其它源码反查）
3. 同义词 `APPS.HZ_PARTIES` 自动解析到 `AR.HZ_PARTIES`

**实现**：调用 plugin 内嵌的 nodejs 子模块 `lib/plsql/cli.js`，该模块直接 `require('oracledb')` 连库，不依赖任何外部 amway 项目的源码。DB 凭据从 `EBSJR_PLSQL_AMWAY_CONFIG_DIR/config/config.{env}.json` 读取（amway 项目作为凭据源，不作为代码源）。

**前置**：必须先跑过一次 `/skill:ebs-jira-review-plsql-init` 装好依赖。

**设计原则**：增量、可重复跑、对网络/数据库故障容错。如果数据库不可达 → 仅用本地已有快照模式，打 WARN 不阻断（评审报告会标注"PL/SQL 上下文基于 N 小时前快照"）。
</objective>

<args>
- **TICKET_ID**：必传，形如 `TE-1250`
- **env**（可选）：`dev|qa|pd`；不传则用 `EBSJR_PLSQL_DEFAULT_ENV`（默认 `dev`）
</args>

<process>

## Step 1 - 参数解析 + 前置检查

```bash
. ~/.ebs_jira_review.conf
. ~/.pi/agent/ebs-jira-review/lib/jira_helpers.sh

TICKET_ID=$(extract_ticket_id "$ARGUMENTS") || {
  echo "✗ 用法：/skill:ebs-jira-review-plsql-refresh TE-XXXX [env]"
  exit 1
}

ENV=$(echo "$ARGUMENTS" | grep -oiE '\bdev\b|\bqa\b|\bpd\b' | head -1 | tr 'A-Z' 'a-z')
ENV="${ENV:-${EBSJR_PLSQL_DEFAULT_ENV:-dev}}"
case "$ENV" in
  dev|qa|pd) : ;;
  *) echo "✗ env 必须是 dev|qa|pd，得到 '$ENV'"; exit 1 ;;
esac

# 前置：node 子模块必须装好
if ! ebsjr_plsql_check_installed; then
  echo "✗ PL/SQL 子模块未安装"
  echo "  请先跑：/skill:ebs-jira-review-plsql-init $ENV"
  exit 1
fi

echo "── plsql-refresh ──"
echo "  Ticket: $TICKET_ID"
echo "  Env:    $ENV"
echo "  Cache:  ${EBSJR_PLSQL_LOCAL_CACHE:-(auto)}"
echo "  Depth:  ${EBSJR_PLSQL_DEPCHECK_DEPTH:-1}"
echo "  TTL:    ${EBSJR_PLSQL_REFRESH_TTL_HOURS:-24}h"
```

## Step 2 - 找 ticket 目录，提取对象清单

ticket 目录必须已经被 `/skill:ebs-jira-review-review` 处理过（`diff/` 目录已生成）。

```bash
WORK_DIR="${JIRA_WORK_DIR:-/mnt/c/Jira}"
TICKET_DIR="${TICKET_BASE:-${WORK_DIR}/ticket}/${TICKET_ID}"

if [ ! -d "$TICKET_DIR" ]; then
  echo "✗ ticket 目录不存在：$TICKET_DIR"
  echo "  请先跑 /skill:ebs-jira-review-review $TICKET_ID"
  exit 1
fi

# 从 diff/ 和 diff/decl/ 抽对象名（去掉 .pkb/.pks/... 扩展名）
# 文件名约定：xxamw_xx_ar_pkg.pkb.diff → 对象 XXAMW_XX_AR_PKG, type=PACKAGE BODY
OBJ_LIST=$(find "$TICKET_DIR/diff" -maxdepth 2 -name "*.diff" -type f 2>/dev/null \
  | while IFS= read -r f; do
      base=$(basename "$f" .diff)
      stem="${base%.*}"
      ext="${base##*.}"
      case "$ext" in
        pkb)  type="PACKAGE BODY" ;;
        pks)  type="PACKAGE" ;;
        fnc)  type="FUNCTION" ;;
        prc)  type="PROCEDURE" ;;
        trg)  type="TRIGGER" ;;
        vw)   type="VIEW" ;;
        mvw)  type="MATERIALIZED VIEW" ;;
        tbl)  type="TABLE" ;;
        idx)  type="INDEX" ;;
        seq)  type="SEQUENCE" ;;
        syn)  type="SYNONYM" ;;
        *) continue ;;
      esac
      name=$(echo "$stem" | tr 'a-z' 'A-Z')
      case "$name" in
        APPS_*) owner="APPS"; name="${name#APPS_}" ;;
        *)      owner="XXAMW" ;;
      esac
      printf '%s\t%s\t%s\n' "$owner" "$name" "$type"
    done | sort -u)

if [ -z "$OBJ_LIST" ]; then
  echo "ℹ ticket 无 PL/SQL 对象，无需 refresh"
  exit 0
fi

echo ""
echo "── 检出对象清单 ──"
echo "$OBJ_LIST" | awk -F'\t' '{printf "  %s.%s (%s)\n", $1, $2, $3}'
echo ""
```

## Step 3 - 按对象逐个拉取

`ebsjr_plsql_refresh` 内部走 `node lib/plsql/cli.js refresh`，自动：
- TTL 检查（24h 内已拉过 → 跳过，不连库）
- 拉源码到 `{LOCAL_CACHE}/{env}/{owner}/{TYPE}/{name}.sql`
- 写 `last_refresh.json`
- SYNONYM 自动解析 + 写 `synonym_map.tsv`
- 一阶依赖递归（按 `EBSJR_PLSQL_DEPCHECK_DEPTH`）

```bash
SUMMARY_FILE="/tmp/plsql_refresh_summary_${TICKET_ID}.tsv"
> "$SUMMARY_FILE"

echo "── 增量拉取（TTL ${EBSJR_PLSQL_REFRESH_TTL_HOURS:-24}h 内的对象会跳过） ──"
TOTAL=0; OK=0; SKIP=0; MISS=0; FAIL=0; DB_UNREACHABLE=0

echo "$OBJ_LIST" | while IFS=$'\t' read -r OWNER NAME TYPE; do
  TOTAL=$((TOTAL + 1))
  OUT=$(ebsjr_plsql_refresh "$OWNER" "$NAME" "$TYPE" "$ENV" 2>&1)
  RC=$?
  case "$RC" in
    0)
      # parse the log: any status=pulled, fresh-skip, missing
      STATUSES=$(echo "$OUT" | jq -r '.log[]?.status' 2>/dev/null | sort -u | paste -sd,)
      if echo "$STATUSES" | grep -q "pulled"; then
        echo "  ✔ $OWNER.$NAME ($TYPE) — pulled"
        OK=$((OK + 1))
      elif echo "$STATUSES" | grep -q "fresh-skip"; then
        echo "  ↻ $OWNER.$NAME ($TYPE) — fresh (skipped)"
        SKIP=$((SKIP + 1))
      elif echo "$STATUSES" | grep -q "missing"; then
        echo "  ✗ $OWNER.$NAME ($TYPE) — missing in env $ENV"
        MISS=$((MISS + 1))
      fi
      printf '%s\t%s\t%s\t%s\n' "$OWNER" "$NAME" "$TYPE" "$STATUSES" >> "$SUMMARY_FILE"
      ;;
    3)
      echo "  ⚠ $OWNER.$NAME ($TYPE) — DB unreachable; falling back to local snapshot mode"
      DB_UNREACHABLE=1
      printf '%s\t%s\t%s\t%s\n' "$OWNER" "$NAME" "$TYPE" "db_unreachable" >> "$SUMMARY_FILE"
      ;;
    *)
      echo "  ✗ $OWNER.$NAME ($TYPE) — error RC=$RC"
      echo "    $(echo "$OUT" | tail -1)"
      FAIL=$((FAIL + 1))
      ;;
  esac

  # 如果 DB 已确认不可达，剩余对象不再尝试连库（避免重复超时）
  if [ "$DB_UNREACHABLE" = "1" ]; then
    EBSJR_PLSQL_REFRESH_ON_REVIEW=0
  fi
done
```

## Step 4 - 写上下文 JSON

无论是否成功拉取，最终给每个对象写 `/tmp/plsql_context_${TICKET_ID}.json`：
- 拉到了的对象 → 用本次新数据
- 拉不到的对象 → 用本地已有快照（如果有；context CLI 会返回 freshness 标注过期）

```bash
. ~/.pi/agent/ebs-jira-review/lib/jira_helpers.sh

CONTEXT_FILE="/tmp/plsql_context_${TICKET_ID}.json"
echo "[]" > "$CONTEXT_FILE"

echo ""
echo "── 生成上下文分析（references / called_by） ──"
echo "$OBJ_LIST" | while IFS=$'\t' read -r OWNER NAME TYPE; do
  # 多种 TYPE 同名（PACKAGE + PACKAGE BODY）合并到一个 context
  case "$TYPE" in
    PACKAGE|"PACKAGE BODY"|FUNCTION|PROCEDURE|VIEW|TABLE|SYNONYM|"MATERIALIZED VIEW")
      CTX=$(ebsjr_plsql_context "$OWNER" "$NAME" "$ENV" 2>&1)
      ;;
    *)
      continue
      ;;
  esac
  if echo "$CTX" | jq -e '.object' >/dev/null 2>&1; then
    TMP="${CONTEXT_FILE}.tmp.$$"
    jq --argjson c "$CTX" '. + [$c]' "$CONTEXT_FILE" > "$TMP" && mv "$TMP" "$CONTEXT_FILE"
  fi
done

# 去重（PACKAGE + PACKAGE BODY 重复算同一对象）
jq 'unique_by(.object)' "$CONTEXT_FILE" > "${CONTEXT_FILE}.tmp" && mv "${CONTEXT_FILE}.tmp" "$CONTEXT_FILE"

echo ""
echo "── 上下文摘要 ──"
jq -r '.[] | "  \(.object): refs=\(.references | length), called_by=\(.called_by | length), pulled=\(.freshness.pulled_at // "(本地无快照)")"' "$CONTEXT_FILE"
echo ""
echo "→ 上下文已写入：$CONTEXT_FILE"
```

## Step 5 - 完工提示

```bash
echo ""
if [ "$DB_UNREACHABLE" = "1" ]; then
  echo "⚠ DB 不可达 — 部分对象走的是本地已有快照（pulled_at 字段可看新鲜度）"
fi
echo "✔ PL/SQL 上下文已就绪 — 可以跑 /skill:ebs-jira-review-review $TICKET_ID 让评审使用"
```

</process>

<failure_modes>

| 失败 | 现象 | 处理 |
|---|---|---|
| 子模块未装 | Step 1 报"子模块未安装" | 跑 `/skill:ebs-jira-review-plsql-init` |
| ticket 目录不存在 | Step 2 报"ticket 目录不存在" | 先跑 `/skill:ebs-jira-review-review` |
| ticket 无 PL/SQL 对象 | Step 2 提示"无需 refresh"，0 退出 | 正常情况 |
| 单对象拉失败但 DB 可达 | Step 3 显示 ✗ 但 DB_UNREACHABLE=0 | 通常是对象在该 env 不存在（ORA-00942/04042），记 missing 后继续 |
| DB 不可达 | Step 3 RC=3，DB_UNREACHABLE=1 | 后续对象不再尝试连库，仅用本地已有快照；最终评审标注新鲜度 |
| amway config 错 | refresh CLI 直接抛出错误 | 跑 `/skill:ebs-jira-review-plsql-init` 重新验证 |
</failure_modes>

<output_summary>
**给用户看的**：
- 检出对象 N 个，pulled=K / skipped=M / missing=L / failed=P
- 是否触发了 DB 不可达回退
- 上下文 JSON 路径

**给 review 用的**：
- `{EBSJR_PLSQL_LOCAL_CACHE}/{env}/{OWNER}/{TYPE}/{NAME}.sql`（实际源码 / DDL）
- `{EBSJR_PLSQL_LOCAL_CACHE}/.ebsjr_index/last_refresh.json`（TTL 表）
- `{EBSJR_PLSQL_LOCAL_CACHE}/.ebsjr_index/synonym_map.tsv`（同义词映射）
- `/tmp/plsql_context_${TICKET_ID}.json`（review 的 sub-agent 会读）
</output_summary>
