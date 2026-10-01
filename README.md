<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="branding/logo-horizontal-dark.svg">
    <img src="branding/logo-horizontal-light.svg" width="420" alt="CaretLex">
  </picture>
</h1>

CaretLex 是一个面向英文 Markdown 阅读的本地桌面应用。阅读时选中单词，手动确认原型和中文释义，词条便会作为标准 Markdown 脚注保存在原文件中。

词条随 Markdown 一起复制、同步和版本管理，不需要账户、云服务或独立词条数据库。

## 使用方法

1. 点击“打开 Markdown”选择英文文档，或点击“新建文档”。
2. 在阅读视图中选中一个完整的英文单词，点击“存为词条”。
3. 确认词条原型（lemma），填写中文翻译；英文例句会从选词所在句子预填，也可以修改。
4. 保存后，原文词形下方会显示虚线。悬停或聚焦该词即可查看词条。
5. 在词条卡中查看完整 JSON、修改词条内容，或删除该词条及其全部正文引用。

同一 lemma 出现在多个位置时，各位置共用一条定义。再次选择新位置并使用相同 lemma，只会添加引用，不会覆盖现有释义。

## 阅读与编辑

- 阅读视图支持标题、列表、引用、表格、任务列表、普通脚注、图片和代码块高亮。
- 多个文档可以在标签页之间切换。
- “源码”模式提供 CodeMirror 编辑器；修改通过“保存源码”或 `Ctrl/Cmd + S` 写入文件。
- 源码有未保存修改时，切回阅读模式、关闭标签或关闭窗口都会询问保存、放弃或取消。
- 磁盘文件被其他程序修改时，CaretLex 会保留本地草稿并提示冲突，不会直接覆盖外部内容。
- “导出 JSON”将当前文档中的托管词条导出为 `lemma → 完整词条值` 对象。

## 词条在 Markdown 中的样子

```markdown
# A short trip

She went[^w-go] to school. He goes[^w-go] home.

<!-- caretlex:vocab:start -->
[^w-go]: {"word":"go","translation":"去","example":"She went to school."}
<!-- caretlex:vocab:end -->
```

CaretLex 只修改目标词形后的引用和文末托管区块。支持 GFM 脚注的其他 Markdown 阅读器会把这些词条显示为普通脚注。

## 设置

设置页提供以下内容：

- 跟随系统、亮色和暗色主题；
- 完整的词条 JSON 模板和字段绑定；
- 设置 JSON 文件的位置选择，可放入用户自己的同步目录。

默认词条包含 `word`、`translation` 和 `example`。自定义模板可以保存任意合法 JSON 值。

## 使用范围

CaretLex 使用简体中文界面，只提供手动存词。选词入口接受单个英文单词以及单词内部的 ASCII 撇号或连字符，不处理短语，也不连接在线或离线词典。

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
```

Linux x64 安装产物通过 `npm run dist:linux` 构建到 `dist/`。当前 deb 配置包含 `.invalid` 占位发行信息，只用于本地测试。

## 更多文档

- [产品说明](doc/PRODUCT.md)
- [文件协议](doc/PROTOCOL.md)
- [架构说明](doc/ARCHITECTURE.md)
- [品牌资产](branding/README.md)
