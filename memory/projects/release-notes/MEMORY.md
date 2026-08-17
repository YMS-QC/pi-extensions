**ebs-svn-openssl-legacy-config** — Amway EBS SVN 服务器 `https://cnnt034.na.intranet.msd/svn/CHINA_OEBS/...` 用老 TLS，本机 OpenSSL 3.0.13 默认拒绝，报 `svn: E120171: SSL communication`（即 `ebs-jira-review:svn-init` 要"写 OpenSSL 兼容配置"的原因）。

**绕过**：写一个 cnf 并用 `OPENSSL_CONF` 指向它再跑 svn：
```
openssl_conf = openssl_init
[openssl_init]
ssl_conf = ssl_sect
[ssl_sect]
system_default = sysdef
[sysdef]
Options = UnsafeLegacyRenegotiation
CipherString = DEFAULT:@SECLEVEL=0
MinProtocol = TLSv1
```
用法：`OPENSSL_CONF=/tmp/ssl_legacy.cnf svn list --non-interactive --trust-server-cert <URL>`

凭据已缓存在 `~/.subversion/auth/svn.simple/`（svn-init 缓存，永不落盘明文）。仓库根 `CHINA_OEBS/` 与 `Trident/` 上级被路径授权挡住（E175013 禁止访问），只能访问 `Trident/xxamw` 子树。相关：[[xxamw-svn-is-per-ticket-deploy-jars]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**isg-upgrade-json-wrapper-kong-fix** — EBS 12.2.5→12.2.14 升级后，ISG REST（如 `XX_ITAX_INVOICE_IN/process_itax_invoice`）JSON 解析改为 XSD 驱动严格校验：裸参数报文（无包装层）报 500 `ISG_SERVICE_EXECUTION_ERROR`/InstanceId 0。需要的包装结构：`{"intg_Input":{"InputParameters":{...}}}`（无需 @xmlns）。ISG 无开关恢复宽松解析。

解决：外围系统经 **Kong 3.4.2（开源）** 转发，在精确 route（`strip_path=false`）上挂 pre-function 插件包装报文。脚本在 `release-notes/lua/`（v4：fail-open + 全局 pcall + BOM 剥离；历史版本在 lua/history/，演进见 lua/CHANGELOG.md）：
- `wrap-isg-sandbox.lua`：纯 PDK 沙箱安全版，须配 `KONG_NGINX_HTTP_CLIENT_BODY_BUFFER_SIZE=16m`（3.4.2 上 buffer 是硬上限；`max_allowed_file_size` 参数 Kong 3.8 才支持）
- `wrap-isg-filebody.lua`：io 读 nginx 临时文件兜底版，须 `KONG_UNTRUSTED_LUA=on`

**最终选了方案B（filebody）**：实测 35KB 报文即落盘，sandbox 版读不到。用户环境疑似 K8s Helm（prefix=/kong_prefix），环境变量须重建 Pod 才生效。部署方案见 `lua/方案B_filebody_部署方案.md`。**关键发现**：不用 `untrusted_lua=on`，用 `KONG_UNTRUSTED_LUA_SANDBOX_ENVIRONMENT=io.open` 最小注入（源码 link() 支持点号路径；整个 io 含 popen 有命令执行风险）；注入是叠加非替换，ngx/kong/string 不受影响。提交脚本必须用 `lua/deploy/` 无注释版 + `--form @file`（带注释版换行丢失会 schema violation）。日志约定：`[ISG-WRAP][request_id]` 前缀，向 EBS 透传 `X-Kong-Trace-Id` 头；`wrapped ok, src=file:` 是读盘生效的验收锚点。注意 MOS 我访问不了（403），引用的 MOS note 只看得到标题。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**jdev-oaf-project-setup** — 把现有 OAF 源仓接进 JDev 10g（OAExt）的要点（完整指南见 `release-notes/JDeveloper_10g_OAF_配置指南.md`）：

**OA 工程必须配两处路径，都指**源码仓根**（含包第一段 `xxamw\` 的那层，**不能指到 `xxamw\` 本身**，否则丢前缀）：
1. Project Properties → **Project Content → Java Content**（管 .java），Excluded 排除 `.git`/非 OAF。
2. Project Properties → **Oracle Applications 节点 → MDS XML Path**（管 .xml MDS 文档）。**最易漏**——漏了打开 `.xml` 报 `not in the XMLPath 'myprojects;...oamdsxml\fwk'`。`MDS XML Path From Libraries`=框架 oamdsxml\fwk，别动。

**建工程入口**：File → New → General → "Workspace Configured for Oracle Applications"，或 Navigator 右键 Workspaces → New OA Workspace（此版没有叫 "OA Workspace" 的叶子项）。Wizard Step1 Directory 直接填仓根、包填 `xxamw.oracle.apps`；Step2 本地有 xml 就不勾 Repository；Step3 填 DBC+用户+职责。

**jvm.dll 启动报错三步**：用 `jdevbin\jdev\bin\jdevw.exe`（非顶层 jdeveloper.exe）；jdev.conf 加 `SetJavaHome <install>\jdevbin\jdk`；复制 `jdk\jre\bin\msvcr71.dll` 到 `jdev\bin\`。

**IDE 文件 `*.jpr/*.jws/*.jpx` 要 gitignore**：含绝对路径，且 Runtime Connection 口令明文存在 .jpr 里。

**工程文件的父目录必须正好是 `<JDEV_USER_HOME>\myprojects` 才能 Run/Debug 页面**（OA Extension 硬校验；编译消红线不受限，仓根也能编）。注意是"**直接在 myprojects 里**"而非"在 myprojects 之下"：放仓根、或放 `myprojects\XXAMW\` 这种**子目录**，都弹 `Cannot Run … OA Project must reside in the 'myprojects' di
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**jdev10g-stdlib-jar-must-split-zip64** — 给 OAF 本地编译挂的标准产品类 jar（从服务器 `$JAVA_TOP/oracle/apps` 打的 `ebs_std_apps.jar`）**全量 ≈ 24.8 万条目**，超经典 ZIP 的 65535 条目上限 → 自动变 **ZIP64**。但 **JDeveloper 10.1.3 跑在 JDK 1.6.0_23（Java 6），`java.util.zip` 不支持读 ZIP64**（Java 7 才支持）。

**症状**：客制扩展类编译报 `superclass not found`（如 `XXNotificationPageAMImpl extends NotificationPageAMImpl`、`XxAuditRuleSetsVOImpl extends AuditRuleSetsVOImpl`）+ 连锁 `method ... not found in class java.lang.Object`。容易误判成 .jpr 配置/路径错——其实路径、库引用、类都对，纯粹是**大 jar 老 JDev 读不全**（只看到一小部分条目）。

**修复**：按 `.class` 拆成每个 < 65535 条目的经典 ZIP（`zipfile.ZipFile(...,ZIP_STORED,allowZip64=False)`）。本环境 15.4 万 .class → 4 个 `ebs_std_classes_01..04.jar`，全挂上。ADOP 后重拉重跑拆分脚本。

脚本/步骤见 `release-notes/JDeveloper_10g_OAF_配置指南.md` §10.5–10.8；本机 .jpr 已把 4 个 jar 写进同一库 `Ebs_std_apps.jar` 的 classPath。相关：[[jdev-oaf-project-setup]]。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**oaf-amwadj-needs-ntfs-case-sensitive** — `C:\amway_repo\oaf\xxamw\oracle\apps\ar\amwadj\server\` 含**两个仅首字母大小写不同的并存类**：`omsAdjAMImpl`(小写, `class omsAdjAMImpl`, addAdjCO/searchAdjCO 用) 与 `OmsAdjAMImpl`(大写, CreateOMSAdjustmentsCO/OmsAdjpymtVerifyCO 用)，连同 `omsAdjAM.xml`/`OmsAdjAM.xml`。服务器(Linux)上是两个不同部署类。

NTFS 默认大小写不敏感 → 普通 copy/解压会把小写覆盖、丢文件 → 编译报 `omsAdjAMImpl not found`。**已修**：对该目录 `fsutil file setCaseSensitiveInfo "<dir>" enable`（管理员，目录需先清空再 enable）+ 从服务器 scp 回两份。

**重新克隆/拷贝本仓到 Windows 必做**：对该源目录 **和** 编译输出目录 `C:\ebsApps\jdev\myclasses\xxamw\oracle\apps\ar\amwadj\server` 都开目录级大小写敏感，否则两文件再合并。WSL/git 建的目录常自带该属性；Explorer/解压不会。JDev Rebuild 重建输出目录可能丢该属性、需重开。

**推荐(给新同事，一劳永逸)**：子目录创建时继承父目录的大小写敏感属性 → **新机器搭仓，先建空仓根 `C:\amway_repo\oaf` 并 `fsutil ... enable`，再把源放进去**（子目录全继承）；编译输出根 `C:\ebsApps\jdev\myclasses` 同理。或整个拷贝/checkout 动作在 WSL 里做（WSL 自动给所建目录打敏感属性）。对已填充目录 enable 不回溯，故"先开根再放文件"顺序关键。

整合脚本当年"去重 omsAdj*→OmsAdj*"是**误删真实不同类**，已纠正。相关：[[jdev-oaf-project-setup]]、[[oaf-consolidated-git-repo]]、配置指南/`release-notes/本地编译_源码适配变更.md` §4。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**oaf-consolidated-git-repo** — OAF 客制源整合 git 仓。**位置**：`C:\amway_repo\oaf`（WSL `/mnt/c/amway_repo/oaf`）；构建暂存 `~/oaf`（原生盘，权威副本）。**48 commits**。

**最终结构**：
- `xxamw/` — **纯 OAF：778 .java + 901 .xml + OAFPersonalization 个性化文档 + BC4J/MDS 定义**。JDev 用 **OA Project**，Source Path 指到仓根（`xxamw.oracle.apps.*`）。
- `non_oaf/` — **已分离的非 OAF Java（24 java）**：`xxamw/oracle/apps/gl/request`、`inv/request` 两个并发程序（implements JavaConcurrentProgram）；`iby/bep/saferpay/**` Saferpay 支付集成（SaferPayServlet extends HttpServlet + JSON）；`com/amway/mailermonitor`、`com/alibaba/cloudapi/client` 独立 Java。JDev 用普通 Java 工程。
- `lib/XXR2REXT8056GBLA.jar` — 阿里云 SDK + com/amway/alicloudapi 编译类（保留 jar，后续处理）。
- `_removed_backup_dirs.txt` — 清理记录。

**来源**：服务器 `$JAVA_TOP/xxamw` 完整部署源（2026-05-25 拉到 `~/oaf_server`，java+xml 与 class 同部署）。历史前 43 commit = SVN `mds/*.jar` 工单增量按时间序（作者=真实提交人）。

**已做清理**：① 删 24 个备份包目录（`.日期`/`_bk`/`_NNNN`/`_DDMonYY`，约 1052 java 死代码）；② 去重 2 个大小写碰撞（omsAdj*→OmsAdj*）；③ 按"是否 OAF"分离非 OAF 到 non_oaf/（OAF 判据：extends OA 框架/产品类；非 OAF=并发程序/HttpServlet/独立 main；注意 *AMImpl 的 main() 是 JDev 测试入口属 OAF）。

**关键纠错（别重蹈）**：曾误判"缺源 1363 需反编译"——错在 `find /u01 /home /app` 搜错根；OAF 源完整在 `$JAVA_TOP/xxamw`，没丢。"238 碰撞"也是误判（同名不同目录不冲突），真碰撞仅 2。

**待办**：`com/amway/aliclouda
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**xxamw-svn-is-per-ticket-deploy-jars** — Amway EBS 客制 SVN 仓 `C:\svn\xxamw`（WSL: `/mnt/c/svn/xxamw`）**不存 OAF 源码树**，存的是按 Jira 工单（TE-xxx）打包的**部署 jar**。OAF 源（.java + BC4J/MDS .xml）藏在 `mds/*.jar` 里（43 个，r150→r1389）。

**坑**：
- 同一文件被多个工单 jar 各自打包（如 `AssetTransactionAMImpl.java` 出现在 7 个 jar），"当前最新"= 按 **svn last-changed-date 正序**取最后一个。
- jar 内部根目录不一致：多数根是 `xxamw/`，少数多包一层壳（如 `R2R_EXT_821_GBL_TE-225/xxamw/`）→ naive `unzip -o` 覆盖不会归一，必须**剥壳**（找最浅的 `xxamw` 目录 re-root）。
- jar 还混入大量 `.class` + 第三方库（okhttp/okio/fasterxml…）+ 标准 `oracle/` 类，重建时只留 `xxamw/` 下 .java/.xml/.properties。
- `_src.jar`（XXD2DITI8042C_src、XXAOLEXT8012C_src）是 `com/amway`、`com/alibaba` 的**独立非 OAF 工具类**。

**重建方法**：`svn info --show-item last-changed-date/revision/author`（离线可用）排序 → 逐 jar 剥壳抽 `xxamw/` 源 → git commit（作者/时间用 svn 真实值）。已产出 [[oaf-consolidated-git-repo]]。

**OAF 发布流程（据 Jira `*_Migration_TE-*.xlsx` 还原，详见 oaf 仓 `RELEASE.md`）**：交付=工单 jar(`Trident/xxamw/mds/`)+SQL，带 SVN rev。部署：①备份 $JAVA_TOP 上 .java/.xml→`.YYYYMMDD`(这就是备份文件来源) ②解压 jar `cp -r xxamw $JAVA_TOP/` ③**`javac $JAVA_TOP/.../X.java` 就地编译**(OAF Java=服务器编译) + **`XMLImporter` 把 MDS 页面/区域 .xml 导入 DB** + SQL + personalization 指 CO ④`adcgnjar` 打 `customall.jar` ⑤bounce oacore。→ 证实源=.java+.xml(入仓)，.class/customall.
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
