<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="branding/logo-horizontal-dark.svg">
    <img src="branding/logo-horizontal-light.svg" width="420" alt="CaretLex">
  </picture>
</h1>

CaretLex 是一个面向英文 Markdown 阅读的本地桌面应用。阅读时选中单词，检查自动数据或手动填写，确认原型与上下文释义，词条便会作为标准 Markdown 脚注保存在原文件中。

词条随 Markdown 一起复制、同步和版本管理，不需要账户、云服务或独立词条数据库。

## 使用方法

1. 点击“打开 Markdown”选择英文文档，或点击“新建文档”。
2. 在阅读视图中选中一个完整的英文单词，点击“存为词条”。
3. 确认词条原型（lemma），编辑完整最终 JSON；可在设置中启用 LLM 自动填写。原句以 `[]` 标记真实选词位置，标记只存在于词条数据中。
4. 保存后，原文词形下方会显示虚线。悬停或聚焦该词即可查看词条。
5. 在词条卡中查看完整 JSON、修改词条内容，或删除该词条及其全部正文引用。

同一 lemma 出现在多个位置时，各位置共用一条定义。再次选择新位置并使用相同 lemma，会追加新的标记原句 context；同原句 key 保留人工释义。完整 JSON 手改以确认的最终值写入。

## 阅读与编辑

- 阅读视图支持标题、列表、引用、表格、任务列表、普通脚注、图片和代码块高亮。
- 多个文档可以在标签页之间切换。
- “源码”模式提供 CodeMirror 编辑器；修改通过“保存源码”或 `Ctrl/Cmd + S` 写入文件。
- 源码有未保存修改时，切回阅读模式、关闭标签或关闭窗口都会询问保存、放弃或取消。
- 磁盘文件被其他程序修改时，CaretLex 会保留本地草稿并提示冲突，不会直接覆盖外部内容。
- “导出 JSON”将当前文档中的托管词条导出为 `lemma → 完整词条值` 对象。

顶部原生菜单使用简体中文，按“文件、编辑、视图、窗口、帮助”组织。“文件”提供新建、打开 Markdown、保存、另存为、导出词条 JSON、关闭标签页、设置和退出；macOS 的设置与退出位于 CaretLex 应用菜单。保存、模式切换和关闭操作保留未保存提示、取消保稿与文件版本检查；设置页打开时，文档菜单操作停用，工具栏的“设置”切换开关、`阅读`/`源码`直接返回文档。

常用快捷键为 `Ctrl/Cmd+N` 新建、`Ctrl/Cmd+O` 打开、`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+Shift+S` 另存为、`Ctrl/Cmd+W` 关闭标签、`Ctrl/Cmd+,` 设置。`Ctrl/Cmd+Shift+R` 和 `Ctrl/Cmd+Shift+E` 分别进入阅读与源码模式。编辑菜单提供撤销、重做、剪切、复制、粘贴与全选；视图菜单提供模式切换、主题、缩放和全屏。

## 词条在 Markdown 中的样子

```markdown
# A short trip

She went[^w-go] to school. He goes[^w-go] home.

<!-- caretlex:vocab:start -->
[^w-go]: {"lemma":"go","contexts":[{"original_sentence":"She [went] to school.","meaning_in_context":"（动词）去","english_definition":"to move or travel"}],"other_meanings":[]}
<!-- caretlex:vocab:end -->
```

CaretLex 只修改目标词形后的引用和文末托管区块。支持 GFM 脚注的其他 Markdown 阅读器会把这些词条显示为普通脚注。

## 设置

设置页提供以下内容：

- 跟随系统、亮色和暗色主题；
- 多个 provider 实例、唯一启用实例、LLM 配置表单与 API 类型选择；
- 全局词典增强：启用 Merriam-Webster Learner's Dictionary 后，词典提供 lemma 和英文释义，LLM 从候选义项中选择并填写中文释义与例句；词典结果缓存在本机 SQLite，词典失败时回退纯 LLM；
- 来源侧响应 JSON 示例，Prompt 支持 `{{article.original_word}}`、`{{article.original_sentence}}` 和 `{{JSON}}` 变量；词典增强启用时还支持 `{{dictionary}}`；发送内容就是设置页里的 Prompt 替换变量后的结果，应用不追加隐藏指令；
- 设置 JSON 文件的位置选择，可放入用户自己的同步目录；
- 可折叠的 provider 实例、分栏连接表单、大尺寸 Prompt 与响应编辑框；
- 恢复默认设置按钮，可修复非法 JSON、无法解码的配置及损坏的路径指针。

默认词条包含 `lemma`、成对的 `contexts` 和 `other_meanings`。表单启用实例时生成实际 name 的完整预设，自定义结构不自动覆盖。保存映射通过设置文件中的 `saveTemplate` 配置，直接修改设置文件不自动套预设。

Key 保存在本机独立明文文件，权限 `0600`；同步设置只保存凭据引用，表单显示掩码形式（前 5 位与后 4 位）并可删除本机 Key。LLM 使用真实非流式 HTTP，严格接受纯 JSON。获取失败仍可手填，晚到结果和重试不覆盖手改稿。保存成功以主进程写入回执为准。

## 使用范围

CaretLex 使用简体中文界面，支持纯手动存词与单个启用的自动 provider。选词入口接受单个英文单词以及单词内部的 ASCII 撇号或连字符，不处理短语。自动类型为 `LLM`，支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini Generate Content。

设置文件包含 `theme`、`providers` 和 `saveTemplate`。无法解析时可点击“恢复默认设置”重新写入；不会自动覆盖损坏文件或转换旧脚注。分句按明确英文规则和样例验收；AI 返回需人工检查。默认 lemma 确认后锁定，自定义结构由用户维护。

本地图片限制在 Markdown 文件所在目录及其子目录内。远程图片需要点击后加载；外部网页链接交给系统浏览器打开。

## 从源码运行

环境需要 Node.js、npm 和可运行 Electron 的桌面会话。

```sh
npm ci
npm run dev
```

类型检查和测试：

```sh
npm run typecheck
npm test
npm run build
```

Linux 原生菜单检查需要 Xvfb 与 D-Bus；先构建，再运行 `npm run test:menu`。检查使用隔离用户数据目录、`XDG_DATA_HOME` 和测试文件，通过真实菜单与快捷键验证中文标签、文件操作、编辑历史、未保存保护、设置页开关、工具栏返回文档和用户级桌面条目；文件选择结果由测试指定。

自动测试与桌面 smoke 使用本地模拟 HTTP 服务验证协议；不代表某个线上服务的联调验证。

Linux x64 安装产物通过 `npm run dist:linux` 构建到 `dist/`。当前 deb 配置包含 `.invalid` 占位发行信息，只用于本地测试。

窗口使用 `branding/app-icon.png` 作为图标；应用启动时会在 `$XDG_DATA_HOME/applications`（默认 `~/.local/share/applications`）写入 `NoDisplay=true` 的 `CaretLex.desktop` 与用户 hicolor 图标，使 Wayland 任务栏能按 app_id 匹配图标，开发运行与未安装的 AppImage 同样生效。条目不出现在启动菜单，安装 deb 后由发行包的同名条目接管。

## 更多文档

- [产品说明](doc/PRODUCT.md)
- [文件协议](doc/PROTOCOL.md)
- [架构说明](doc/ARCHITECTURE.md)
- [验证记录](doc/VALIDATION.md)
- [品牌资产](branding/README.md)
