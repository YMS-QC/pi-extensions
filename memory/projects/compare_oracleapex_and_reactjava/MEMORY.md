**apex-internals-verified** — 2026-06-17 联网核实 APEX 底层，供下次 BTP 会议与书面材料校准口径。相关：[[btp-tech-selection]]。

1. 多 tab 串页：`APEX_CLONE_SESSION` 是 **APEX 5.1（2016/17）** 引入，**非供应商所说"20.x"**。且非自动隔离：须实例级参数 `CLONE_SESSION_ENABLED=Y` + 开发者为每个"开新窗口"入口显式带 `REQUEST=APEX_CLONE_SESSION`；用户自发开 tab / 复制 URL 默认仍共享 session、仍串页。克隆=克隆瞬间复制 session 值后分叉（非实时同步）；一个 session 登出，关联 session 全登出（影响 SSO/会话周期）。结论：**缓解特定开窗场景，非根治**；要求 QA(24.2) 实测两 tab 互改 filter 的真实行为，别只看"有这个选项"。

2. 应用导出/版本控制：`apex export -split`（SQLcl）可拆多文件、Git 可 diff，SQLcl 23.1+ 有 Projects——故"完全没法文件比对审代码"**不准确**，会被供应商反驳。准确口径：可 diff，但 diff 的是机器生成的声明式元数据（SQL/JSON 片段）非手写代码，内嵌原生 JS/PLSQL 散在组件属性里，审查体验远逊源代码级 CR。实测片段(公开库 ujnak/apexapps)证实：是明文、不加密的 `wwv_flow_api.create_*`/`wwv_flow_imp_*` 过程调用，但①靠大数字内部 ID(如 `p_id=>wwv_flow_api.id(9032187016298379)`)②**非 ASCII 文本被 `unistr()` 转义成十六进制码点**(样例 `unistr('\30DB\30FC\30E0')`=日文"ホーム")——故界面中文文案在 diff 里是转义序列、看不出改了哪句文案，对中文界面项目审查体验再打折(可作"可比对≠可人读"的硬证据)。

3. APEXlang：**APEX 26.1（2026-05 GA）全新**声明式语言，把应用表示为可 diff/merge/review 的 `.apx` 文本，是版本控制/代码治理特性——**不是多语言、也不是 20.1**。会议中 Jimmy 误称"apex Lin 是 20.1、应该是多语言"，供应商前几轮误答成 XLIFF 翻译——两边都混了，下次须修正。立场不变：26.1 新特性不作承诺前提。

4. 多语言翻译：独立机制——Seed→Export XLIFF(.xlf)→翻译→Apply→Publish 影子应用；每加页面/按钮都要重跑该循环。XLIFF 机制成熟，但影子应用 + 增量
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**btp-scheduler-decision** — 方案B 异步任务/定时调度选型（2026-06，三轮 fork 尽调）。对照 APEX automation = DBMS_SCHEDULER 跑生产 DB（见 [[apex-internals-verified]]）；项目背景 [[btp-tech-selection]]。

**默认选 `@Scheduled + ShedLock`**：Java 同栈、零新增服务、仅在 XXBTP 加一张锁表、无回连、应用无状态跟现网双 DC 容灾走。管理界面 = Spring Boot Admin（Actuator `/scheduledtasks` 只读）+ 自建简单任务列表页。最契合"任务不多（TM1 同步/异步导出/TTL 释放/对账）+ 不要太复杂（Steven）"。大导出走 Java 流式（fetchSize + 边读边写对象存储），不在 DB 物化（对照 `APEX_DATA_EXPORT` 物化 LOB）。

**升级路径 = PowerJob**（触发：任务规模变大 / 要业务自助可视化管理）：server 调度 + worker SDK 嵌入应用，**双向通信**（server→worker 下发是容器化最大坑——回连 Pod 内网 IP，需 worker 显式上报可回连地址 + expose 端口 + 防火墙放行）；不要求同集群但要 server↔worker + server→元数据库三向可达；**必需独立关系元数据库**（MySQL/PG/Oracle，别放 EBS 生产库）；MongoDB 只存在线日志、可砍。生产不轻。

**不选 Airflow**：Python 与 Java 栈双重错配（最致命）、组件最重（metadata DB + scheduler + webserver + executor[+MQ/worker]）、碰不到 Spring bean 只能 HTTP 外部戳、任务相互独立用不上 DAG/回填。UI 最强但不值为它养一个 Python 平台。仅当未来真出现复杂跨系统 ETL 编排（多步依赖+回填）且已有 Python/Airflow 平台才评估。

**不选 Temporal**：durable execution 引擎，有一流 Java SDK（不错配），但运维最重（Server 多服务集群 frontend/history/matching/worker + Cassandra/PG/MySQL + 可选 ES），内网只能自建（Cloud 撞出站红线）。核心价值（长流程可靠恢复/saga 补偿）本项目用不上——预算占用是 PL/SQL 短事务。唯一可能戳中的是占用单据生命周期（预占→转正→核销→释放/TTL/乱序补偿），但已由同源内核的 PL/SQL 状态机 + 幂等表 + DBMS_SCHEDULER TTL +
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**btp-tech-selection** — 预算控制引擎(BTP)选型（2026-06 启动）：预算额度来自 IBM TM1，外围系统（采购/报销）调占用接口，前端挂 EBS 职责菜单。方案A=供应商的 APEX 26.1 全栈（现有同库双节点 LB）；方案B=React+Java 经 ebs-ngnix-layer OpenResty 网关反代（网关阶段0/1/2 已验证，待办：EBS 侧真实 authcheck 端点）。

硬性前提：预算内核（锁/跨年占用/长周期项目/层级控制）统一落一体机独立 XXBTP schema 的 PL/SQL 包，两方案同源；均不用 EBS 并发管理器；占用接口峰值 100 TPS；上线后可能第三方运维。方案B 前端 React 或 Vue 均可。

关键架构事实（2026-06-10）：APEX 走独立域名 cnebs*apex（F5 443 虚拟服务器 + iRule 对 /ords/ 重写 Host=主机:8080、Origin、XFP/XFPort）——与 EBS 跨域名，EBS Cookie 不随行，方案A 的 EBS 菜单跳转需独立认证衔接（D-18/19、PoC-4 核心考点）；方案B 为同域路径 /xxbtp，Cookie 随行已实测。iRule 硬编码主机名且改写浏览器 Origin（掩盖真实来源），属脆弱配置，建议核实 ORDS 标准代理配置替代。

产出物（本目录）：《预算控制引擎技术选型比较表.xlsx》（47 项比较，A-H 八类；G-40 自助式列表为方案A占优项；G-42 含对话框决定提交走向场景、G-43 多页签防串单（APEX 架构级痛点，APEX_CLONE_SESSION 缓解）、G-44 多语言影子应用机制均已按 24.2 核实；24.2 基线全表已核验，

集成红线（用户定，2026-06）：数据库不做出站接口调用——生产库无 Oracle Wallet 且不为本项目配置（EBS 生产库上变更有风险）。传导：APEX 方案的 TM1 拉取/OSS 直连/IM短信/PWA 推送（发送端=DB 出站调公网推送服务）全部不可用，须改为推送进 ORDS（入站不受限）或外挂独立集成服务；方案B 出站在 Java 层天然合规。已写入 Checklist 约束⑦、内部表"集成红线"条目、PPT 第 5 页红框。A接口/B业务规则/C-TM1/D-EBS集成/E后台报表/F架构运维/G前端能力 + 7 个强制 PoC：100TPS压测/跨年长周期/导出中心/职责SSO/后台运维/TM1双模式/前端高保真）；《供应商反馈Checklist_APEX方案.xlsx》（发供应商，要求写明实现机制+依据+限制，不接受笼统回答）。各含术语表。utPLSQL 不强制，认可接口层数据驱动回归。另有《EBS反代网关方案说明.pptx》（10 页，build_
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
