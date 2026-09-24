# CaretLex 架构说明

> **状态：实现说明与验收基线。** 阶段状态和实际检查结果见 [ROADMAP.md](./ROADMAP.md)。产品边界见 [PRODUCT.md](./PRODUCT.md)，文件格式见 [PROTOCOL.md](./PROTOCOL.md)，选型缘由见 [DECISIONS.md](./DECISIONS.md)。

## 1. 目标与不变量

CaretLex 是**阅读英文 Markdown、用简体中文界面手动存词**的本地桌面软件。首版默认阅读，提供可选源码编辑，不提供所见即所得编辑。词条的唯一持久副本是 Markdown 文件中的脚注定义；索引、解析树、预览卡和导出内容都从文件重建。应用设置另存为可同步的 UTF-8 JSON 文本。首版没有数据库、外部词典、账户或云服务。

必须守住三项不变量：

1. 词条操作只改目标正文引用和托管区块；其它原文的 UTF-8 字节、换行符和 BOM 原样保留。用户明确进行的源码编辑不受这个限制。
2. 写盘前验证文件版本与协议结构。不能确定选词的唯一源码位置或托管区块损坏时，拒绝词条操作并保留原文。
3. 渲染进程不能直接读写任意文件，也不能执行 Markdown 中的 HTML/脚本；文件和设置写入只经主进程的受限 IPC。

## 2. 进程与模块

```text
Electron 主进程
  窗口和原生文件对话框
  DocumentRepository：打开、版本检查、原子保存、watch
  SettingsRepository：设置 JSON、路径指针、版本检查、watch
  ExportService：当前文档的托管词条 JSON
  IPC handlers：鉴别来源、校验参数、调用上述服务
                 │ 类型化、受限 IPC
Electron preload：逐个暴露方法与事件订阅
                 │
Vue 3 渲染进程
  Pinia：标签页、当前快照、草稿、诊断、主题
  Reader：remark AST → 安全 DOM、词条锚点、悬停卡
  SelectionMapper：DOM 选区 → 经验证的源码区间
  ManualProvider：模板绑定、录入和显式 JSON 编辑
  CodeMirror 6：可选源码模式
                 │
共享纯 TypeScript 核心，无 Electron/DOM/文件系统依赖
  协议解析、词条索引、诊断、源码区间校验、定点补丁、JSON 序列化
```

渲染进程用共享核心预览，**主进程在写盘前仍重新验证**，不能相信渲染进程送来的索引、选区或补丁。解析源为 `remark-parse + remark-gfm` 的 mdast；阅读视图与源码定位共用这棵语法树，不使用另一套解析器做位置判断。Shiki 只处理代码块高亮，不更改 Markdown 协议。CodeMirror 6 只用于源码模式；其文档状态由编辑事务维护，用户保存时才写回文件。[remark-gfm 官方说明](https://github.com/remarkjs/remark-gfm)列出脚注、表格和任务列表等扩展；[CodeMirror 官方参考](https://codemirror.net/docs/ref/)说明其编辑器状态与视图。

| 模块 | 输入 → 输出 | 不承担 |
|---|---|---|
| `core/protocol` | Markdown 文本 → mdast、词条 Map、诊断及源码区间 | 文件 I/O、界面状态 |
| `core/patch` | 已校验快照 + 语义操作 → 有序、不重叠补丁 | 全文 Markdown 重排 |
| `core/settings` | 原始 JSON → v1 设置与诊断；模板 + 绑定 → 草稿 JSON | 执行用户脚本 |
| `main/repositories` | 路径/快照/补丁 → 磁盘读写、版本事件 | HTML 渲染 |
| `renderer/reader` | 已解析模型 → DOM、可见文本位置映射 | 自行写盘 |
| `renderer/provider` | 选词上下文 + 草稿 → 用户确认的 JSON | 隐式联网或自动词形还原 |

## 3. 核心类型与接口

下列类型表示模块契约；实现时应与 [PROTOCOL.md](./PROTOCOL.md) 的 v1 格式逐项核对。

```ts
type JsonValue =
  | null | boolean | string | number
  | JsonValue[]
  | { [key: string]: JsonValue };

type SourceSpan = { start: number; end: number }; // 左闭右开，UTF-16 偏移；不含 BOM
type Revision = string; // 原始文件字节的 SHA-256

interface DocumentSnapshot {
  id: string;                 // 打开会话内的不可猜测句柄
  path?: string;              // 未命名文档无路径
  text: string;               // 严格 UTF-8 解码，BOM 单独记录
  revision?: Revision;        // 未写盘文档无磁盘版本
  bom: boolean;
  eol: '\n' | '\r\n' | '\r'; // 文件首个换行符；无换行时用 LF；已有行不转换
}

interface VocabRecord {
  lemma: string;              // 标签身份，不依赖 JSON 体内的 word 字段
  value: JsonValue;           // 对象不是必要条件
  definitionSpan: SourceSpan;
  referenceSpans: SourceSpan[];
  managed: boolean;           // 位于唯一完整托管区块内
}

interface SelectionContext {
  documentId: string;
  sourceSpan: SourceSpan;     // 经源码定位校验
  selected: string;           // 原文可见词形
  sentence: string;           // 可编辑的默认原句
}

type ResolveResult =
  | { kind: 'value'; value: JsonValue }
  | { kind: 'cancelled' };

interface EntryProvider {
  readonly id: string;
  resolve(context: SelectionContext, draft: JsonValue): Promise<ResolveResult>;
}
```

`null` 是合法的 JSON 顶层值，不能同时拿它当取消信号；provider 必须使用判别联合。数字要限制为有限值，防止 `JSON.stringify` 把 `NaN`/`Infinity` 静默改成 `null`。首版唯一 provider 是 `manual`；自动查词和词形还原只是后续扩展缝隙，不创建假数据源。

`SourceSpan` 采用 [unist 的 UTF-16 偏移定义](https://github.com/syntax-tree/unist#point)，与 JavaScript 字符串索引及 DOM 文本偏移同单位，并非 UTF-8 字节偏移。`DocumentRepository` 保留原始 `Uint8Array`，建立 UTF-16 边界到 UTF-8 字节边界的映射。含 emoji 等代理对时不能切在代理对中间；输入不是严格 UTF-8 时不能进行词条写入，须显示编码错误。BOM 独立记录，避免所有 AST 偏移错位。

## 4. 读取、分类与渲染

打开 `.md` 后，主进程按原始字节计算 revision，严格解码 UTF-8，再由共享核心解析。词条分类、`[^w-lemma]`、`<!-- caretlex:vocab:start -->`/end、单行 JSON 定义以 [PROTOCOL.md](./PROTOCOL.md) 为准。索引每次从文档重建，不落盘。同一 lemma 的多处引用进入同一记录。区块外合法词条可阅读，不能被应用接管编辑或删除。无效 JSON 按普通脚注渲染；区块内无效内容、重复定义（包括 GFM 标识符归一化后冲突的标签）、区块重复/错序/未闭合等产生带源码范围的诊断，并阻止**整篇文档**的词条写入和导出。重复定义须额外检查原始源码，不能只依赖可能保留首个定义的 AST。

阅读器由同一 mdast 转换为安全 DOM。普通脚注保留 GFM 的上标和文末列表。合法词条引用隐藏上标及文末定义，紧邻的原文词形用中性虚线下划线标记，约 300ms 后显示词条卡。卡片对默认对象显示 `word`、`translation`、`example`；自定义 JSON 值可展开查看完整内容，缺少这些键也不能阻止查看。有效引用若无可识别的相邻词形，保留可见引用标记并显示诊断，不能静默丢失。

锚点标记与源码映射一起从 mdast 构造。须处理 `went[^w-go]`、`*went*[^w-go]` 这类词与引用分属不同 AST 节点的情形，不能靠渲染后的字符串搜索或 `innerHTML` 替换。标题、段落、列表、引用、表格、加粗/斜体内的普通文本可选。代码、链接文字、原始 HTML、托管区块不提供存词入口；跨不同格式节点的选区若无法获得唯一连续源码区间，也禁用存词。

## 5. 可见选词到源码区间

浏览器 `Selection` 不是 Markdown 源码位置。转义、实体解码、强调标记、CRLF 及文中多个相同词都会让“可见第 N 个字符 = 源码第 N 个字符”的假设失效。

`SelectionMapper` 必须按以下顺序工作：

1. 渲染每段可选文字时保存 mdast 源码范围，并建立可见 UTF-16 边界 → 源码 UTF-16 边界映射；转义或实体造成的非等长转换要逐段记下源码跨度。
2. 读取 anchor/focus；确认选区属于当前文档的单个可支持文本区域，而且恰为一个完整英文词。允许内部 ASCII 撇号与连字符，首尾必须为英文字母。多词、跨块、代码、链接、HTML 区域拒绝。
3. 映射成唯一 `SourceSpan`，从原始 Markdown 验证该区间在当前解析上下文呈现为同一个可见词，且目标位置未带同一词条引用。失败则禁用存词并说明原因；绝不能用 `indexOf` 猜测重复词位置。
4. 在已解析的可见文本中提取所在句；句界不清楚时取当前文本块。原句只是可修改草稿，不参与源码定位。用户确认小写 lemma；应用不推断 `went → go`。

由转义或实体构成的词，只有确认插入点紧贴完整源码词形时才支持存词。开发第 0 项必须用真实 parser 和 DOM 原型证明映射覆盖承诺节点及常见转换；做不到先修正定位方案，再进入写盘开发。[unist 位置定义](https://github.com/syntax-tree/unist#point)

## 6. 词条操作与定点补丁

渲染进程发**语义命令**，不发自由文本补丁。主进程重新读取/核实 revision、解析并校验选区和区块，再生成不重叠的补丁，按偏移从后向前应用。

```text
阅读选词 → 精确 SourceSpan → manual 录入并确认 JsonValue
  → IPC addVocabulary(documentId, baseRevision, sourceSpan, lemma, value)
  → 主进程验证同一快照、引用状态及区块
  → 词后插入 [^w-lemma]，建立或更新排序后的托管定义
  → 将 SourceSpan 换算为 UTF-8 字节范围，拼接未触及的原始字节片段
  → 原子保存 → 重新解析 → 返回新 revision/诊断 → 刷新打开视图
```

已有 lemma 的新位置复用定义，不覆盖其 JSON，不增加计数；同一位置已有对应引用则无变化。新 lemma 用 `JSON.stringify` 写单行值；默认新对象的字段顺序为 `word`、`translation`、`example`，自定义模板可生成任意 `JsonValue`。定义按 lemma 排序。编辑托管词条只替换定义值，不动引用。删除托管词条同时删除定义与正文中全部对应引用，保留原词。区块外词条只能阅读；用户显式源码编辑可以自行修改原文。

每个补丁带预期原文片段或哈希，校验范围互不重叠且落在允许边界。不能用 `remark-stringify` 或其它全文序列化实现词条操作；渲染等价但重排空白或换行仍不合格。首次建托管区块只向文末增加必要分隔和区块；其后只改区块内部与目标引用。针对 BOM、混合换行、文末有无换行分别验证；新行使用文件约定，已有行完全不动。

## 7. 写盘、watch 与冲突

`DocumentRepository` 为每个实际路径建立串行操作队列：

- 打开时读取原始字节并计算 SHA-256 revision；写前再次读取并比较原始字节 revision，不能只看 mtime。源码草稿持有开始编辑时的 base revision。
- 词条操作立即保存；源码模式只在显式“保存”时提交全文草稿。切回阅读、关闭标签或窗口前，未保存草稿须由用户选择保存或放弃。新文档首次保存先经原生对话框取路径。
- 同目录建立唯一临时文件，写完并同步文件内容后关闭；紧邻 rename 前再校验目标 revision。失败时清理临时文件，保留草稿与原文件，不能报告成功。目标平台还要验证替换和权限保留语义。[Node rename 文档](https://nodejs.org/api/fs.html#fsrenameoldpath-newpath-callback)
- `fs.watch` 外改事件后重读，按 revision 区分自身写入和真实外改。没有草稿则重解析并更新索引；有草稿则标出“磁盘已更改”并禁止覆盖，提供重新加载或另存副本。watch 的事件、文件名和 inode 并非跨平台可靠；它负责及时提示，**每次写前读盘比较才是冲突门槛**。[Node watch 限制](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)
- 同一物理路径只对应一个文档会话；重复标签若存在须共享 revision 和保存队列，防止互相覆盖。

这是乐观并发控制：写前比较不是跨进程的原子 compare-and-swap，不能杜绝其他编辑器在最后比较与 rename 之间极短窗口内写入。验收不能声称完全消除这种竞态。已检测到冲突时必须保留草稿和原始快照，不自动合并。

## 8. 可同步的设置 JSON

格式以 [PROTOCOL.md](./PROTOCOL.md) 的 v1 规范为准：`version`、`theme`、`providers`、`entryTemplate`、`bindings`。绑定键是 JSON Pointer，值为 `{from: ...}`；来源限 `selected`、`lemma`、`sentence`、`manual`、`constant`。默认 `/word` 来自用户确认的 lemma，`/translation` 来自必填的“中文翻译”手填，`/example` 来自可修改原句。模板允许任意合法 JSON 值。模板和绑定不匹配、指针无效或版本不支持时，拒绝保存并显示精确诊断，不隐式修复。用户提供的是数据，不能执行脚本或表达式。

默认完整设置是应用配置目录里的 UTF-8 JSON 文本。用户从设置页迁往同步路径时，先将完整设置原子写入新路径，再把配置目录的本地路径指针写成一个小 JSON 文本；后续以新路径为准。指针不含模板或词条。启动时目标文件不存在或不可读，应显示错误和重选入口，不悄悄新建并覆盖。设置外改同样用 revision/watch；若本地设置草稿未保存，进入冲突状态而不覆盖磁盘。设置改变只影响新建或显式编辑的词条，不迁移既有 JSON。不能额外维护数据库或二进制持久副本。

设置页首版可编辑并校验完整 JSON 模板；默认三字段保留简洁表单，自定义结构在录入卡中编辑原始 JSON。最终值必须经 JSON 解析和绑定校验后才能写入，提供保存前预览；合法顶层 `null` 也可保存。

## 9. 标签页、源码模式与 IPC

Pinia 每个标签记录 `documentId`、路径/标题、已保存 revision、阅读模型、模式、未保存的源码草稿、外改冲突和诊断。主题属于设置，不写入 Markdown。阅读模式只读；CodeMirror 6 修改源码后显式保存，再重新解析。watch 收到新 revision 时，要更新所有共享该文档会话的标签，而不只是前台标签。

preload 逐个暴露方法，不暴露通用 `ipcRenderer` 或任意路径读写：

```ts
interface CaretLexBridge {
  openMarkdown(): Promise<OpenDocument | null>;
  newDocument(): Promise<OpenDocument>;
  saveSource(input: { documentId: string; baseRevision?: string; text: string }): Promise<SaveResult>;
  saveAs(input: { documentId: string; text: string; baseRevision?: string }): Promise<SaveResult | null>;
  addVocabulary(input: AddVocabulary): Promise<SaveResult>;
  editVocabulary(input: EditVocabulary): Promise<SaveResult>;
  deleteVocabulary(input: DeleteVocabulary): Promise<SaveResult>;
  exportCurrentVocabulary(documentId: string): Promise<ExportResult | null>;
  loadSettings(): Promise<SettingsSnapshot>;
  saveSettings(input: SettingsUpdate): Promise<SettingsSnapshot>;
  chooseSettingsPath(): Promise<SettingsSnapshot | null>;
  onDocumentChanged(callback: (event: DocumentChanged) => void): () => void;
  onSettingsChanged(callback: (event: SettingsChanged) => void): () => void;
}
```

路径仅由主进程原生打开/保存对话框或已登记句柄产生。每个 IPC handler 校验发送窗口/Frame、句柄归属、参数结构和大小，事件订阅可取消，关闭标签时清理。Electron 官方建议通过 `contextBridge` 逐方法暴露，不要透传整个 IPC。[IPC 教程](https://www.electronjs.org/docs/latest/tutorial/ipc)、[上下文隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

## 10. 内容安全与资源

窗口设 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`；应用页只加载打包资源，配置限制脚本和资源来源的 CSP，不加载远程脚本或 `webview`。Markdown 原始 HTML 安全显示为文本或忽略，绝不经 `innerHTML`/`rehype-raw` 执行。自定义 mdast→DOM 节点只创建固定组件和转义文字；词条 JSON 只当文本显示。

链接点击时由主进程校验协议及目标；只允许用户动作触发的 `https:`、`http:` 或 `mailto:` 外部打开，禁止 `javascript:`、`file:` 等危险协议和自动导航。Markdown 原始 HTML 以转义后的源码放在固定 `<pre>` 中显示，不执行、不插入 DOM。相对本地图片只允许当前 Markdown 文件所在目录及其子目录；路径规范化后还会通过已打开文件描述符检查真实路径，因此越界的符号链接也拒绝。远程图片默认占位，用户可单次主动加载，避免打开文档就向远端发送请求；图片读取限制为 10 MiB。限制新窗口、导航和权限请求，验证 IPC 来源。[Electron 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)

## 11. 当前文档 JSON 导出

导出只接受已登记的当前 `documentId`。主进程检查磁盘 revision，重新解析托管区块，遇到阻断诊断即拒绝。输出为**单行 JSON 对象**：键是 lemma，值是定义的完整 `JsonValue`。按 lemma 排序，用无原型对象或 `Map` 聚合，避免特殊键影响对象原型；`JSON.stringify` 后由原生保存对话框选 `.json` 路径，再用临时文件与替换写盘。比较目标与打开文档路径前先解析已有目标的真实路径，避免通过符号链接选中打开中的 Markdown。只读当前文档托管词条，不扫文件夹，不转 CSV/Markdown，不混入区块外词条。用户取消对话框不是错误；真正 I/O 失败应提示。

## 12. 实施门槛与实际结果

共享核心、仓储和打包应用验收结果列于 [ROADMAP.md](./ROADMAP.md)。下表仍作为维护或扩展时不可降低的门槛；未实际验证的安装包和原生对话框操作不会因为核心单测通过而视为完成。

| 阶段 | 必过验证 |
|---|---|
| 第 0 项 parser/DOM spike | 同标签多引用、普通脚注、`w-`、撇号/连字符 lemma；标题、段落、列表、引用、表格、强调中的单词均定位唯一源码范围。重复同形词、转义、实体、CRLF、emoji、跨格式节点与禁选区域给出正确结果或明确拒绝。 |
| 协议和补丁 | 首次建区块、已有词合并、重复位置无变化、编辑/删除全部引用、顶层 `null`、损坏/重复定义、区块外词条。逐字节断言非目标范围完全相同；覆盖 BOM、CRLF、混合换行、文末有无换行。 |
| 文件与设置 | 外部编辑导致写前冲突且草稿保留；watch 后索引重建；同路径多标签互不覆盖。设置迁移、外改、丢失、版本错误、坏 JSON 和绑定错误均有可恢复反馈。 |
| 安全和界面 | 恶意 HTML、`javascript:` 链接、路径穿越图片、伪造 IPC 参数不能执行或越权读取；阅读/源码切换、IME、关闭未存草稿、悬停卡和完整 JSON 展示正常。 |
| 导出 | 只含当前文档托管区块，任意 JSON 值保留，键顺序稳定，坏区块拒绝，取消保存不报错。 |

### 本地运行与 Linux x64 构建

使用 Node 22.23.2 已验证。仓库用锁文件固定依赖版本；开发运行、类型检查、核心测试和构建命令如下：

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run dist:linux
```

打包窗口回归命令：

```sh
env -u WAYLAND_DISPLAY xvfb-run -a node tests/integration/packaged-smoke.mjs dist/CaretLex-0.1.0-x86_64.AppImage
```

AppImage 已通过此流程。测试 deb 使用 `example.invalid` 占位主页和维护者信息，已解包运行并通过同一窗口冒烟；该包不可发行或分发。正式 deb 需要替换成真实发行元数据，并在受支持系统中安装后验证。详细状态见路线图。

资料均来自项目官方文档：[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[remark-gfm](https://github.com/remarkjs/remark-gfm)、[unist 位置定义](https://github.com/syntax-tree/unist#point)、[CodeMirror 参考](https://codemirror.net/docs/ref/)、[Node 文件系统](https://nodejs.org/api/fs.html)。
