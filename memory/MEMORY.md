# pi 环境备忘 (2026-08-17)

## 仓库架构 (vendor 单仓)
- 唯一维护仓: YMS-QC/pi-extensions (本地 ~/private_repo/pi-extensions, private), 不再 fork 任何仓库
- packages/stack/=第三方收纳区 (pi-telegram/pi-automode/pi-hermes-memory, subtree 带补丁); packages/=自有资产
- settings.json 唯一 git pin: git:github.com/YMS-QC/pi-extensions@main; 上游同步=仓内 update-vendors.sh
- 原则/知识/记忆快照: 仓内 memory/ 区, ./sync-memory.sh pull|push

## 模型管理
- 单一真源: ~/.pi/agent/model-profiles.json (/models 命令, 自有插件 model-config)
- profiles: default/cheap/deep/peak; 5 target: main/automode/hermes/subagents/heavy
- 自有插件源码: pi-extensions/packages/pi-model-config + deploy.sh 部署到 ~/.pi/agent/extensions/

## 记忆
- pi-hermes-memory (vendor 于 stack/, 含 PI_HERMES_* env + /memory-reload 补丁), CC 记忆已迁移
- 后台 LLM: zai/glm-4.7 (llmModelOverride), 迁移脚本 ~/private_repo/migrate-cc-memory/

## 子代理
- ~/.pi/agent/agents/: scout/worker/reviewer(预算化)+deep-researcher+reverser(挂 RE skill), 存档 ~/private_repo/pi-agents/
- settings.json subagents.defaultModel=glm-4.7 + agentOverrides 分层

## Telegram
- bot @pijmy_bot (id 8899490542), @llblab/pi-telegram v0.29.0, token 在 ~/.pi/agent/telegram.json (600)
- 走 sing-box tun 全局代理 (出口 107.175.94.152); 长轮询无需公网
- 未认主: 首个 /start 的 TG 用户为唯一 owner

## 其他
- 快捷键: shift+tab 切模式, ctrl+shift+n 新会话(=/new≈CC clear), ctrl+alt+m 模式选择器
- automode 护栏会拦"改安全控制文件"——改 automode/hermes 源码前需 /automode off
§
用户环境为 WSL (Ubuntu 22.04)，Node v22.23.0，全局安装 @earendil-works/pi-coding-agent 至 ~/.npm-global。使用 sing-box tun 模式全局代理 (出口 107.175.94.152)。 <!-- created=2026-08-16, last=2026-08-16 -->
§
用户偏好单一真源配置，避免多处硬编码。使用 ~/private_repo/pi-config/sync-models.py 同步模型配置至 settings.json/automode.json/hermes-memory-config.json。现已升级为私有 model-config 扩展实现全栈热切换。 <!-- created=2026-08-16, last=2026-08-16 -->
§
用户偏好离线启动 (PI_OFFLINE=1) 和静默启动 (quietStartup: true)。偏好 TUI 全屏模式。 <!-- created=2026-08-16, last=2026-08-16 -->
§
用户已完成从 Claude Code (CC) 到 Pi coding agent 的迁移，核心里程碑包括：CC 记忆迁移至 pi-hermes-memory (SQLite FTS5)、fork 并优化 pi-automode (notifications/bashFastPath/decisionCache)、实现统一模型管理、建立分层子代理配置。 <!-- created=2026-08-16, last=2026-08-16 -->
§
私有插件仓库位于 ~/private_repo/，包含 pi-automode (YMS-QC/pi-automode), pi-hermes-memory (YMS-QC/pi-hermes-memory), pi-model-config, pi-personal (个性化配置总仓) 等。 <!-- created=2026-08-16, last=2026-08-16 -->
§
Pi 会话中 `/new` 命令相当于 CC 的 `/clear`，但旧会话保留可通过 `/tree` 回溯。已绑定 `ctrl+shift+n` 至 `app.session.new`。 <!-- created=2026-08-16, last=2026-08-16 -->
§
Telegram bot @pijmy_bot (id 8899490542) 已集成，使用 @llblab/pi-telegram v0.29.0。配置位于 ~/.pi/agent/telegram.json，长轮询走 sing-box tun 全局代理，已认主 (首个 /start 用户为 owner)。 <!-- created=2026-08-16, last=2026-08-16 -->
§
子代理模型分层策略：scout/researcher/delegate 使用 glm-4.7+low，worker 使用 glm-5.3+medium，reviewer/oracle 使用 glm-5.3+high。deep-researcher 和 reverser 为自定义高预算代理 (model: glm-5.3+high)，配置在 ~/.pi/agent/agents/。 <!-- created=2026-08-16, last=2026-08-16 -->
§
Pi-automode fork (YMS-QC/pi-automode) 新增特性：notifications 配置 (all/statusOnly/none)、bashFastPath (确定性允许层)、decisionCache (LRU 缓存)。默认 notifications=statusOnly 以减少噪音。 <!-- created=2026-08-16, last=2026-08-16 -->
§
用户决策：Drift 检测改为全量检查（放弃缓存增量模式），理由是环境特定差异（如首页文案）需要长期感知，且可优化性能。需配合 ignore 机制（如 `OASimpleHomePG`/`AnnouncementRN`）和分类输出（区分真漂移/待部署/环境差异）。 <!-- created=2026-08-16, last=2026-08-16 -->
§
Drift 当前检出漂移的处置原则：1. repo 领先（已 merge 未部署）→ 等待 DBA 部署；2. env 领先（绕过 git 直改库）→ 必须做 `ebs intake` 拉回 repo 补 TE；3. 假阳性（normalize/工具缺陷）→ 修工具；4. 环境特定差异（如首页文案）→ 加 ignore 清单。 <!-- created=2026-08-16, last=2026-08-16 -->
§
§
§
§
**EBS-核心架构** — Oracle E-Business Suite R12.2.14 中国区客制代码仓。dev/qa/ps/prd 连接已配(APPS账号)。OAF .java运行期=customall.jar(需DBA重生jar+bounce)。R12.2 EBR表名带#后缀(如AR_CASH_RECEIPTS_ALL#),trigger/索引挂_ALL#表。chore分支只MR到prd,qa用`git push --force origin prd:refs/heads/qa`对齐。Forms个性化纳管口径=RULE_KEY IS NULL。ISG REST alias在FND_SOA_SERVICES不在.pls。APEX基线以qa为准无drift。PO不用AME PR用AME。WF调AME经包装包(PO_AME_WF_PVT等)。详情见AGENTS.md。 <!-- created=2026-08-17, last=2026-08-17 -->
§
**EBS-dev-工具链** — ebs CLI统一入口`node .localtool/bin/ebs.js <cmd>`。核心命令:intake(捕获,oaf/ame/apex/db)、deploy(--check校验/真部署)、release(产DBA交付件)、validate(trailer检查)。连接配置`config.<env>.json`+passwordFile(口令不入仓)。wft-json引擎替代.wft作git载体(JSON往返字节等价)。oaf-open直达OAF页(RF.jsp token)。drift检测=全量检查(repo vs 运行库)。详见GETTING_STARTED.md+localtool/DEV_TOOLKIT.md。 <!-- created=2026-08-17, last=2026-08-17 -->
§
**EBS-部署模型** — qa/prd=git为准,环境领先=异常(hotfix绕过git)。dev共享环境不设基线分支。*-DEPLOYED tag=git==环境锚点。DB schema DDL=.tbl/.idx/.seq声明式不部署,新建/修改走TE-*.sql幂等块。release产deploy_manifest.txt(五段)+deploy_source,DBA用稳定执行器`ebs-git-deploy.sh`。业务feature=`feature→qa→prd`两MR同分支,基建chore=`chore→prd`单MR。详见WORKFLOW.md。 <!-- created=2026-08-17, last=2026-08-17 -->
§
**EBS-WF/AME** — WF通知链:SendSingle→defer WF_DEFERRED→Mailer dequeue→SMTP。WF调AME经包装包(PO_AME_WF_PVT/POR_AME_REQ_WF_PVT等)非直接AME_API2。AME 95%客制(404规则中382个),含动态审批组(XX* IS_STATIC='N')。PO不用AME PR用AME(实测wf_items)。WeCom审批=XX_AOL_WX_API_PKG轮询wf_notifications推UTL_HTTP。WFLOAD DOWNLOAD用lib/wft.js wfDownloadDb纯DB(与WFLOAD字节等价)。wft-graph可画审批流程图(静态)。 <!-- created=2026-08-17, last=2026-08-17 -->
§
**EBS-文档/风格** — 写文档三条红线:1)不体现loop 2)agent定位=辅助开发+合规非自治 3)check/deploy不覆盖个性化。memory风格=言简意赅/好理解/不堆黑话/不恭维,关联用[[name]]。skill不引用私有memory(fact直接写正文)。commit不加Co-Authored-By: Claude trailer。GitLab runner=专用机,项目共享runner已禁用。 <!-- created=2026-08-17, last=2026-08-17 -->
§
pi-hermes-memory 插件配置(~/.pi/agent/hermes-memory-config.json): memoryCharLimit/userCharLimit/projectCharLimit 默认各 5000(2026-08-17 已调 memory/project=100000, user=20000)。**limits 是 pi 启动快照, 改配置须重启 pi 才生效**(reload-config 只热加载 LLM override 项)。overflow 时 auto-consolidate 子进程 180s 超时会失败(consolidationTimeoutMs 可调)。memory_replace 的守卫要求 content 包含被替换条目的全部保留行, 想整条换新内容用 remove+add 更直接。 <!-- created=2026-08-17, last=2026-08-17 -->
§
用户调研了 Pi 的 /btw（side-question）替代方案：1) @narumitw/pi-btw (v0.52.0, 活跃维护，同 pi-goal 作者)，仅问答无工具权限，支持独立模型配置；2) pi-btw (dbachelder, v0.4.1, 已停更)，支持子会话工具权限；3) 两者均非官方包。 <!-- created=2026-08-17, last=2026-08-17 -->
§
Pi extensions monorepo 架构 (YMS-QC/pi-extensions): vendor 模式收纳所有需修改的第三方包 (packages/stack/), 自有子包放 packages/ 根。上游同步直接 git subtree pull 原始仓 URL (无需 fork 中转)。SOURCES.md 书面化来源基线。settings.json 仅 pin git:github.com/YMS-QC/pi-extensions@main (源码直载零构建)。 <!-- created=2026-08-17, last=2026-08-17 -->
§
用户偏好：回复要言简意赅，不要恭维，不说废话，缩写要合理，不编造口语化缩写；写文档时人可读性优先于简洁；读取 Office 文件前先检查是否有 skill，写 Excel 推荐 exceljs 或 office cli；验证 UI 时优先用 agent-browser skill；检查网页效果优先读源码而非视觉 MCP；核对知识时找官方文档并核对现场，不虚构。 <!-- created=2026-08-17, last=2026-08-17 -->