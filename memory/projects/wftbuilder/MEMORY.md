**wftbuilder-attr-value-name** — **修正**:节点属性值(ACTIVITY_ATTRIBUTE_VALUE)的 `NAME` **不要求**命中活动声明的 ACTIVITY_ATTRIBUTE。

证据:
- 实盘 POAPPRV 的 GET_NOTIFICATION_ATTRIBUTE 节点声明 0 个 ACTIVITY_ATTRIBUTE,但有 NTF_USER_NAME/NTF_USER_ROLE 值(函数参数约定)。
- exe 属性值页是 **SysListView32**(三列列表视图,含 "List1" 控件,来自 WFPROC.OCX),可自由命名。
- vendored `vendor/ebs/lib/wft-json.js` 入库只校验 `value_type` 枚举(CONSTANT/ITEMATTR),NAME 直接 INSERT 到 `wf_activity_attr_values`,不校验声明。

UI 已改:AddAttrValue 的 属性名 为自由输入(声明属性+保留名做 datalist 建议,允许自定义);"未声明"徽标弱化为 muted 色 + 中性 tooltip。文档 `~/wft/docs/exe-attrs.md` §9 已同步修正。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**wftbuilder-default-icon** — Oracle WF Builder 的 `DEFAULT_.ICO` 是**内置通用默认图标**(新建 ItemType/Process 的默认),**不是 fallback 到某个具体 .ico 文件**——它的图像内嵌在 `WFNVG.OCX` 资源里(不在 Icon 目录的 112 个 .ico 中)。

逆向证据:icoutils `wrestool` 提取 WFNVG.OCX 的 26 个嵌入组图标,与 app 112 集逐像素对比,5 个 0% 精确匹配(FUNCTION/PROCESS/EVENT/FLXPROC/TRANSFRM)证明嵌入集就是活动图标集;独立图标 `14_1`(灰色文档+右上卷边+内嵌橙色内容)最像通用默认,已采纳。

产出:`DEFAULT_.ICO.png`(32x32)入库 `extension/media/icons/` + `app/public/icons/`,icons.json(webview+app)注册 `DEFAULT_.ICO → /icons/DEFAULT_.ICO.png`。SVG 模式 ICON_SVG_MAP 仍映射 `DEFAULT_ → CircleDot`(未改)。

注意:该 OCX 资源段非标准(.rsrc rawsize=0、数据偏移相对资源区基址),手写 PE 解析会失败;正确姿势是 objdump 定位绝对 RVA 或直接用 `wrestool -x --type=14 --all` 提取组图标。
<!-- created=2026-08-16, last=2026-08-16 -->
§
**wftbuilder-engine** — wftbuilder 的核心是 `.wft`(WF_LOAD 文本格式)↔ `WftJson` 双向,纯 JS 进浏览器 bundle,**无 fs/无 DB**。

**两个引擎模块**:
- `src/lib/wft-parse.ts` — `.wft` 文本 → `WftJson`。预处理(去注释 + 合并 `\` 续行)→ 状态机(DEFINE 深度跳 schema 段 + BEGIN/END 建通用树 + `FIELD="val"` 取字段)→ 按 ITEM_TYPE 跨引用归组(LOOKUP_TYPE 按 ITEM_TYPE 字段、MESSAGE/ACTIVITY 按双键首键)→ 镜像 jsonToWft 字段映射。
- `src/lib/wft-stringify.ts` — `WftJson` → `.wft`。移植自 migrate `localtool/lib/wft-json-io.js` 的 jsonToWft(DEFINE_SCHEMA 静态块 + wftLine/wftBlock/wftBeginLine/dnPair),镜像发射序 ITEM_TYPE→LOOKUP_TYPE→MESSAGE→ACTIVITY→ROLE。浏览器版跳过 Buffer 无效字节后处理(浏览器文档 _invalid_bytes 通常空)。

**往返等价**:`parse→stringify→parse` 保持节点/边/实体一致。验证:XXAOL475 5n/5e、APINVAPR APPROVAL_INVOICE 38n/51e 往返原样。

**.wft 格式**:`BEGIN <TYPE> "n1" ["n2"]` 块 + `FIELD = "val"` DN 行 + 嵌套,顶部固定 DEFINE schema 模板(声明字段类型,无数据,解析时跳)。长行(>79)`\` 续行;值内 `\n`/`\t`/`\"`/`\\` 转义。键 arity:ITEM_TYPE/ITEM_ATTRIBUTE/LOOKUP_TYPE/LOOKUP_CODE/MESSAGE_ATTRIBUTE/ACTIVITY_ATTRIBUTE/PROCESS_ACTIVITY/ACTIVITY_ATTRIBUTE_VALUE/ROLE=1,MESSAGE/ACTIVITY/ACTIVITY_TRANSITION=2。

**WftJson 数据模型**(`src/lib/wft-parser.ts`):`{ item_types: ItemType[], roles? }`。ItemType={name, display_name?, activities: ActivityDef[], item_attributes?/lookup_types?/messages?}。Act
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**wftbuilder-gotchas** — wftbuilder 开发踩过的非显坑(易复发,记下省二次排查)。

**白屏且 console 无显式报错 = 运行时 import 抛错**:tsc 过 ≠ 模块运行时导出存在。`Fax` 在新版 lucide-react 被移除、types 仍含 → tsc 没拦 → 模块加载即抛 → React 不渲染 → #root 空 → 白屏(import rejection 被吞,console 不报)。
- 排查:对可疑模块逐个 eval-import 定位(`node -e "Object.keys(require('lucide-react'))"` 对照)。
- 新增 lucide 图标一律先核对实际导出,别只信 tsc。详见 [[wftbuilder-project]]。

**agent-browser(CDP)测不了 RF pointer 交互**:节点拖拽、Shift 连线、折点拖这些依赖 React Flow pointer 事件的操作,CDP mouse 不触发 → 无头验证不了。代码靠标准 RF 接线 + mutation 单元测试 + 非拖拽交互(属性编辑/加节点/预检/开存文件)端到端验。真实浏览器拖拽正常。验收拖拽类要在真浏览器或用 eval 派发完整 mousedown/up/click 序列。

**连接范式 = Shift 两步点击**(非右键拖、非 handle 拖):右键连线浏览器手势干扰;handle 拖覆盖节点挡移动。定 = Shift+点源→点目标,或选中节点→Shift+点目标。handle 透明 pointer-events:none(仅让 RF 边渲染,移除则 edges:0)。

**headless 验收用 eval 绕 dblclick**:agent-browser 的 dblclick 对被遮挡的 RF 节点中心不触发,且裸 dispatch dblclick 不触发 React onDoubleClick(需完整 mousedown/up/click 序列)。

**数据模型改造注意**:doc 可能是 EMPTY_DOC(`{item_types:[]}`)兜底——下游 buildProcessGraph/listItemTypes 等对空或非匹配 itemType 要安全(返回空)。mutate 在无选中文档(docKey 不在 docs)时 no-op。

**webview 里 Tailwind v4 工具类缺失(已修,易复发)**:Tailwind v4 自动 content 探测依赖 vite root;extension/webview 构建跨目录扫 app/src 会漏掉 → `.fixed`/`px-3`/`border` 等工具类没生成 → `position:fixed` 变
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**wftbuilder-project** — web 版 Oracle Workflow Builder,**纯前端单页应用**(对标 exe 离线胖客户端)。工作目录 `~/repo/wftbuilder/`(独立 git 仓,内部 GitLab)。2026-08-07 从 `~/wft/app`(scratch)+ migrate 仓的 WF 工作抽离定型。

**核心闭环**:打开 `.wft`/`.json`/文件夹 → 可视化编辑 → 另存 `.wft`/`.json`。**无后端、无数据库、无 CLI、无 vite 中间件**。入库是 WFLOAD/DBA 的活,不在此 app。数据全程浏览器本地,不入仓不联网。

**技术栈**:Vite 8 + React 19 + TS 6 + Tailwind v4 + @xyflow/react 12 + shadcn/ui。固定坐标(非自动布局),`@`→src 别名。`vite.config.ts` 仅 react+tailwind+alias,无任何出站。

**架构关键(改前必读)**:
- **选中态注入**:受控 nodes/edges 无 onNodesChange/onEdgesChange → RF 内部 selected 重渲染被覆盖。FlowCanvas 把 selected 从自家 `selectedNodeId`/`selectedEdgeId` 注入。节点拖动靠本地 `localNodes`+applyNodeChanges,dragStop 回写 doc。
- **平移/缩放**:`panOnDrag={[1]}`(中键)+ panOnScroll(滚轮平移,Ctrl+滚轮缩放);`deleteKeyCode={null}`(自处理)。
- **mutation 纯函数**(`wft-mutations.ts`,structuredClone 不可变,找不到目标返回原 doc)。edge 定位用 `data.from/idx`,**不 split edge id**。
- **undo/redo**:`{docs,hist}` 合一 state,每 docKey 独立 past/future,400ms 合并,no-op 不记;Ctrl+Z/Shift+Z/Y。
- **数据模型**:去编译期 import → 启动空态;「打开文件」(.json+.wft 走 parseWft)/「文件夹」(webkitdirectory 批量)加载进 `docs[docKey]`;QuickStart 新建。DeployBar = 预检(validateDoc 前端)+ 存 .json + 存 .wft(Blob 下载),**无 upload**。

**坑(lucide)**:tsc 过 ≠ 运行时导出存在。`Fax` 在新版 l
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
§
**wftbuilder-vscode-plugin** — **长期目标(2026-08-10 批准计划,跨会话跟踪)**:把 wftbuilder(纯前端 SPA)做成 VS Code 插件,并新增「diff 高亮」特性。已批准计划存 `/home/jimmy/.claude/plans/binary-booping-matsumoto.md`。

**已拍板决策**:
- 目录:**仓库内子目录** `~/repo/wftbuilder/extension/`(与 app 同仓,pnpm-workspace packages ['app','extension','extension/webview'])
- **2026-08-10 解耦(重要,架构已变)**:extension 与 app **不再共享源码**。`extension/webview/src` 是 app 引擎/组件/样式(含 index.css)的**独立拷贝**(vite/host/tsconfig alias `@` 全指 extension 内副本,icons 也在 extension/media/icons);app 复原为纯 SPA(删 bridge-types/edit-op/setIconBase/.wf-webview/App bridge 分支,保留 diff 特性)。引擎**双份**,L1 引擎测试双跑防漂移(`cd app && pnpm test:engine` + `cd extension && pnpm test:engine`)。改引擎要两边同步。
- 形态:Custom Editor(绑 `*.wft`,priority default)+ 独立工作台面板(mode=workbench);`.json` 不绑 editor(会劫持 built-in JSON),走右键命令 openAsEditor
- diff 高亮:①编辑 vs 磁盘实时脏标 ②双版本对比(A vs B)都做;呈现在**画布节点+边高亮 + DiffPanel 变更摘要面板**,**不做 .wft 文本行高亮**
- 插件分发:内部 GitLab 出 .vsix,不进公开 marketplace(项目标注「不外传」)

**关键架构事实(改前必读)**:
- **单一撤销源 = VS Code TextDocument**:webview 编辑→notifyDocChanged(去抖~250ms)→host applyEdit 全量替换→文档 dirty→Ctrl+S 落盘;`onWillSaveTextDocument.waitUntil(flush)` 兜底;webview 内禁用内部 Ctrl+Z/Y(走 contributes.keybindings when activeCustomEditorId+!inField)→postM
…(迁移截断, 原文见 CC memory)
<!-- created=2026-08-16, last=2026-08-16 -->
