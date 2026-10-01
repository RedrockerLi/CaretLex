# 架构说明

本文描述 CaretLex 当前代码的进程边界、模块职责、数据流和运行约束。产品行为见[产品说明](PRODUCT.md)，持久化格式见[文件协议](PROTOCOL.md)。

## 技术栈

- Electron 44：桌面窗口、原生文件对话框、文件系统和外部资源访问；
- Vue 3 + Pinia：渲染进程界面和工作区状态；
- unified、remark-parse、remark-gfm：Markdown AST、脚注和源码位置；
- CodeMirror 6：源码编辑器；
- Shiki：代码块高亮；
- TypeScript + electron-vite：共享类型和三进程构建；
- Vitest：共享核心与仓储测试。

## 进程边界

```text
Electron 主进程
  BrowserWindow、原生对话框、shell/net
  DocumentRepository、SettingsRepository
  词条命令复核、导出与原子写入
                  │
                  │ 受限、类型化 IPC
                  ▼
preload
  contextBridge.exposeInMainWorld("caretlex", bridge)
                  │
                  ▼
Vue 渲染进程
  Pinia 工作区、Markdown 阅读器、词条卡、设置页、CodeMirror

共享 TypeScript 核心
  Markdown 协议解析、选区映射、定点补丁、设置校验
```

渲染进程不直接访问文件系统。`src/preload/index.ts` 逐项暴露 `CaretLexBridge`，不暴露通用 `ipcRenderer`。主进程 handler 校验发送者、参数类型、字符串长度、JSON 可序列化性和文档会话句柄。

## 模块职责

| 位置 | 职责 |
|---|---|
| `src/main/index.ts` | 应用生命周期、窗口安全配置、IPC handler、原生对话框、外链/远程图片和 JSON 导出 |
| `src/main/repositories.ts` | 文档会话、严格 UTF-8、revision、串行写入、文件监听、本地图片、设置文件与路径指针 |
| `src/preload/index.ts` | IPC 方法封装、事件订阅和 JSON 复制 |
| `src/renderer/stores/workspace.ts` | 标签页、源码草稿、冲突、设置草稿和异步操作状态 |
| `src/renderer/components/ReaderView.vue` | mdast 渲染、DOM 选区读取、词条锚点、图片和外链交互 |
| `src/renderer/components/EntryComposer.vue` | 默认录入表单、自定义模板实例化和完整 JSON 编辑 |
| `src/renderer/components/SourceEditor.vue` | CodeMirror 文档状态与显式保存 |
| `src/shared/protocol.ts` | 托管区块、词条、诊断、文本节点映射和选区复核 |
| `src/shared/patch.ts` | 添加、编辑、删除和导出的纯函数 |
| `src/shared/settings.ts` | v1 设置 schema、JSON Pointer 和模板绑定 |

## 文档模型

`DocumentSnapshot` 包含会话 ID、可选路径、正文、SHA-256 revision、BOM 标志和检测到的首个换行形式。文档正文使用 JavaScript 字符串；所有 `SourceSpan` 都是左闭右开的 UTF-16 偏移，并且不计文件 BOM。

`parseDocument` 每次从正文重建：

- remark mdast；
- 可映射文本节点及“可见边界 → 源码边界”表；
- 脚注引用和定义的源码范围；
- 托管区块结构与诊断；
- `Map<lemma, VocabRecord>` 临时索引。

词条索引不写入独立数据库。设置是另一份 UTF-8 JSON 文件，不包含文档词条或解析缓存。

## 选区与词条写入

阅读器把每个可选文本节点标记为 `data-text-run`。浏览器选区必须落在同一个节点中，随后由 `mapVisibleRange` 使用该节点的边界表换算为源码范围。实体、Markdown 转义、CRLF 和 UTF-16 代理对都在边界表中单独处理；边界不明确时返回错误。

渲染进程提交文档 ID、base revision、源码范围、可见选词、lemma 和 JSON 值。主进程重新取得当前快照，并由共享核心执行以下检查：

1. 磁盘 revision 与选择时版本一致；
2. 选词仍对应同一个可选择文本节点；
3. lemma、相邻引用、重复定义和托管区块均有效；
4. 生成的源码补丁互不重叠。

添加操作只在词形末尾插入引用，并创建或重写托管区块内容。编辑只重写托管区块内容；删除同时移除 AST 中匹配的真实引用。补丁按偏移倒序应用，正文其余内容不经过 Markdown stringify。

## 文件仓储与并发

`DocumentRepository` 使用真实路径去重打开会话，并分别按文档 ID 和真实路径串行化操作。文件规则如下：

- 读取使用 fatal UTF-8 解码；文件上限 16 MiB；
- revision 是包含 BOM 的原始字节 SHA-256；
- 保存保留 BOM，源码中未修改的字符和换行不被规范化；
- 临时文件建立在目标目录，写入后执行文件 `fsync`，紧邻 rename 前再次比较 revision；
- 替换时保留目标文件权限位，并在 rename 后尝试目录 `fsync`；
- 目录级 `fs.watch` 负责发现外部变化，真正的写入门槛是保存前重新读取并比较 revision。

新建文档在第一次磁盘操作时通过保存对话框取得路径。另存为不会覆盖另一个已打开会话。检测到外部变化后，有草稿的渲染标签保留草稿和外部快照；没有草稿的标签直接采用外部快照。

设置仓储使用同样的 revision 与临时文件写入方式。默认设置文件是用户数据目录内的 `settings.json`。同步路径模式由 `settings-path.json` 保存绝对路径；设置正文只存在于指向的 JSON 文件中。

## 内容安全

BrowserWindow 配置为 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` 和 `webSecurity: true`。应用页 CSP 只允许自身脚本；图片仅允许自身、`data:` 和 `blob:`。窗口导航、新窗口和权限请求全部拒绝。

阅读器使用固定 Vue VNode 映射渲染 mdast，不使用 `v-html` 或 `rehype-raw`。原始 HTML 放入 `<pre>` 作为文本。外链只接受 `http:`、`https:` 和 `mailto:`。本地图片路径必须在文档目录内，realpath 和打开后的文件描述符路径都要通过边界检查；图片大小上限 10 MiB。远程图片只接受 HTTP/HTTPS、图片 Content-Type 和 10 MiB 以内响应，并由用户点击加载。

## 验证范围

`tests/shared/core.test.ts` 覆盖协议识别、任意 JSON 根值、重复定义、选区映射、定点增删改、导出和设置绑定。`tests/main/repositories.test.ts` 覆盖 BOM、并发写入、严格 UTF-8、本地图片边界、设置冲突和设置路径迁移。`tests/integration/packaged-smoke.mjs` 通过 Electron 调试协议操作打包窗口，覆盖新词、引用复用、编辑、删除、源码保存和重开读取。

仓库中的自动化测试不操作原生文件选择器；涉及打开、另存为、设置路径和导出路径的对话框需要桌面会话中的人工交互。
