# 架构说明

CaretLex 使用 Electron、Vue 3、Pinia、TypeScript、electron-vite、remark/GFM、CodeMirror、Shiki 与 sbd@1.0.19。Markdown 是词条数据源，没有独立词条数据库；`dictionary.sqlite` 只是词典查询缓存。

## 进程与模块

主进程负责本地 article、LLM HTTP、凭据、文档/设置 revision 与文件写入。词条 Map 索引通过 IPC 显式编码为条目数组，在渲染端恢复为 Map。preload 逐项暴露受限 `CaretLexBridge`；renderer 负责草稿、检查和用户交互，不直接访问文件系统或 Key。

| 模块 | 当前职责 |
|---|---|
| `src/main/index.ts` | IPC 参数/发送者复核、窗口与图标、原生对话框、保存回执、导出、图片与外链、启动时安装桌面条目 |
| `src/main/menu.ts` / `src/shared/menu.ts` | 中文原生菜单、命令与状态协议、快捷键、可用性和阅读模式标记 |
| `src/main/repositories.ts` | 文档身份、真实路径去重、严格 UTF-8、revision、监听、串行原子写入、配置恢复和路径选择 |
| `src/main/article.ts` | 从选区定位文本块、可见位置映射、硬换行分段、sbd 与分句适配、marker |
| `src/main/llm.ts` | 可注入 fetch/getKey 的真实 LLM HTTP 适配器、超时、取消、大小/格式检查、词典参考与最终词条组装 |
| `src/main/llm-protocols.ts` | 四种 API 的请求封装、认证头、严格响应文本解析；协议选择不影响通用映射 |
| `src/main/dictionary.ts` | Learner's HTTP 查询、缓存读写、独立超时、错误分类与过期缓存兜底 |
| `src/main/dictionary-cache.ts` | `node:sqlite` 归一化词条缓存、正/负 TTL、统计与清空 |
| `src/main/providers.ts` | requestId 登记、唯一实例选择、来源命名空间、类型描述与预设、版本复核、词典运行时配置传递 |
| `src/main/credentials.ts` | 本机稳定凭据引用、串行 0600 原子写入、损坏文件保护、存在性与掩码查询、按引用删除 |
| `src/main/desktop-integration.ts` | Linux 用户级 `.desktop` 与 hicolor 图标（NoDisplay，供任务栏按 app_id 匹配） |
| `src/shared/providers.ts` | 统一类型/适配器接口、LLM 默认配置与预设、响应示例检查、词典增强默认 Prompt/响应 |
| `src/shared/dictionary.ts` | Learner's 响应解析、候选过滤、参考 JSON、最终词条组装 |
| `src/shared/settings.ts` | 设置配置、单实例校验、词典配置与 Prompt 归一化、明确引用重命名 |
| `src/shared/mapping.ts` | 纯来源路径求值、数组层级与列表展开、字面量、字段诊断 |
| `src/shared/entries.ts` | 身份校验、纯 contexts 合并和精确当前语境匹配 |
| `src/shared/entry-session.ts` | 锁定目标、来源/候选/人工稿/待应用结果、请求代次、失效与失败保留 |
| `src/shared/protocol.ts` / `patch.ts` | Markdown 解析、选区映射、诊断、定点最终值写入、删除与导出 |
| `src/renderer/stores/workspace.ts` | 标签、源码与设置草稿、外部快照、写入回执、未保存提示 |
| `ReaderView.vue` / `EntryComposer.vue` / `VocabCard.vue` | 真实 DOM 选区、会话、完整 JSON、当前上下文与编辑回执 |
| `SettingsView.vue` | 类型表单、预设审阅、响应示例/保存模板/高级 JSON、先存凭据再存设置 |

## 数据流

```text
真实源码选区 + 捕获的文档/设置版本
  → 主进程 article：真实词形、完整标记原句
  → 可选词典增强：Learner's 查询/缓存 → 候选义项与 sense ID
  → 唯一已保存启用且被引用的 provider（词典参考随可见 Prompt 发送）
  → 按义项 ID 用词典释义组装默认来源值
  → 来源 JSON 与字段诊断
  → 保存映射实例化
  → 目标 lemma 的 contexts 合并
  → 完整 JSON 人工稿或待应用结果
  → 主进程和共享核心复核身份、revision、范围、大小
  → 原子文件写入与真实回执
```

普通自动 provider 只接收 article、自己的 JSON config 与 AbortSignal；词典增强启用时，context 还包含超时、凭据引用和增强响应示例。凭据值由主进程按引用取得，不进入 renderer、prompt 或来源结果；设置界面只显示主进程计算的掩码。请求体是设置页 Prompt 的变量替换结果，主进程不附加隐藏 system 文本。词典结果先归一化为候选义项，参考 JSON 随 `{{dictionary}}` 发送；LLM 选择 lemma/义项并填写中文释义与例句，主进程按义项 ID 用词典原文组装默认来源值。词典失败时用 `available:false` 参考继续请求 LLM，英文释义由 LLM 兜底。生产使用真实 fetch；测试注入本机模拟 HTTP 服务或词典客户端。

新增类型实现 `ProviderAdapter`，注册到类型描述/配置注册表和主进程适配器表，提供默认配置与保存预设；通用获取、映射、合并、完整编辑和文件协议沿用同一流程。没有可靠上下文义时明确提示，不以首条词典释义代替。

## 分句与范围

article 由主进程统一提取。最近 paragraph、heading 或 tableCell 内的文本与正常内联文字形成可见字符串，脚注引用与定义跳过；选词位置由 TextRun 的源码边界表取得。实体、Markdown 转义、CRLF 和 UTF-16 代理对在边界表中处理，不按 `indexOf(original_word)` 搜索选中位置。

显式 break 强制分段，软换行保留。[sbd](https://github.com/Tessmore/sbd) 提供缩写/数字基础候选；适配器验证字符保留、处理闭合引号、引号内部多句、直接报告语和大写新句前的 ASCII/Unicode 省略号。任何无法保留字符或无法定位完整句子的情况都失败，不合成引号或返回截断片段。该规则不承担通用语义分句。

## 草稿和并发

EntrySession 捕获 location、设置 revision、目标、来源、候选、文本、手改标记、requestId、待应用值和保存状态。不同标签的阅读器保留内存会话，标签隐藏时取消获取。旧 ID、设置变化和文档失效的结果不应用。有手改时获取结果始终等待明确应用。

词条卡捕获开始编辑时的 documentId、lemma 和 revision。文档监听只更新阅读快照，不丢弃人工文本；旧版本保存被拒绝。主进程以真实文件完成为成功依据。新文档的词条内容通过一次另存写入，不先创建未注释的中间文件。

文档仓储按真实路径与文档 ID 串行操作，最终写入前再读文件并比较 SHA-256。补丁互不重叠，倒序应用，未触及正文不 stringify。设置原始文本和 revision 在非法 schema 时仍可恢复；普通保存拒绝不可解码文件；显式恢复默认设置按文件和路径指针 token 复核后替换配置并保留凭据。凭据写入先于设置保存，失败不切换旧引用。

## 安全与资源

BrowserWindow 使用 sandbox、contextIsolation、关闭 nodeIntegration、固定发送者和 IPC 白名单。页面禁止导航、新窗口和权限请求，不使用 v-html；原始 HTML 以文本显示。本地图片经 realpath 和打开后文件描述符检查限制在文档目录内。远程图片由用户主动加载。AI 与词典请求不跟随重定向，不将 Key 放入请求正文或主动生成的词条字段。词典错误消息不包含完整 URL 或 Key；缓存不保存 Key 或音频。

Markdown 上限 16 MiB；设置、词条、AI 请求和响应上限 1 MiB。JSON 必须有限、无循环且可序列化。响应严格解析，不修补。超时与取消释放定时器，结果经过文档/设置版本再次复核。

## 验证

Vitest 覆盖协议和边界映射、声明的 article 样例、设置及 API 类型校验（含旧默认 Prompt 升级与词典 Prompt 归一化）、数组映射、JSON 子树与字面量、contexts 合并、身份锁定、异步手改保护、配置恢复、损坏/无法解码/超限设置的显式恢复、冲突保护、凭据权限、掩码与按引用删除、迁移隔离，以及桌面条目的内容与幂等写入。词典测试覆盖 Learner's 响应归一化、重定向占位条目与噪声过滤、义项 ID、参考 JSON 裁剪、最终词条组装、SQLite 正/负缓存与过期兜底、缺凭据/超时/HTTP 错误/非法响应、Key 不进入错误消息，以及 adapter 在词典成功和失败时的两条路径。

`tests/main/providers.test.ts` 使用本机 HTTP 服务验证实际请求路径、认证、prompt、JSON mode、外层/内容错误、HTTP 状态、取消、超时与实际字节上限，并验证词典参考、增强响应示例和回退组装。这是协议实现验证，不是某个线上模型服务的联调验证。

`tests/integration/packaged-smoke.mjs` 在隔离用户数据目录中通过 Electron CDP 操作真实打包窗口和本机模拟 API，检查损坏配置的默认设置按钮和真实写入、宽屏/窄屏布局、四种 API 的表单选择和实际获取、DOM 选词、手工/自动 JSON、多实例预设与重命名的保存结果、多上下文、当前悬停、晚到/重试/设置变化、冲突保稿、重开读取与本机凭据。每次启动使用独立 D-Bus 会话和 GTK portal 配置，原生对话框使用同一 Xvfb 显示器。`dialog-keyboard.py` 通过 XTest 驱动真实 GTK 设置位置对话框。

```sh
npm run typecheck
npm test
npm run build
npm run dist:linux
xvfb-run -a node tests/integration/packaged-smoke.mjs dist/linux-unpacked/caretlex
```

HTTP 测试需允许本机监听端口。桌面 smoke 需 Linux 图形库、Xvfb、D-Bus、GTK file chooser/portal、Python、libX11、libXtst、xwininfo 和 ImageMagick 的 `import`。脚本保留设置、录入窗、词条卡和原生对话框截图到 `/tmp/caretlex-*.png`；失败时保留临时用户数据目录。没有提供实际远程服务凭据时，不声明线上服务联调成功。
