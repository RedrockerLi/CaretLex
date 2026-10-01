# 文件协议

本文定义 CaretLex 当前读取和写入的 Markdown 词条、设置 JSON 与导出 JSON。协议实现位于 `src/shared/protocol.ts`、`src/shared/patch.ts` 和 `src/shared/settings.ts`。

## 术语

| 术语 | 含义 |
|---|---|
| 原文词形 | 正文中实际显示的英文单词，例如 `went` |
| lemma | 用户确认的词条身份，例如 `go` |
| 词条引用 | 紧跟原文词形的 `[^w-lemma]` |
| 词条定义 | 使用相同标签、值为单行 JSON 的脚注定义 |
| 托管区块 | 文末两条专用注释之间、允许应用改写的定义区 |
| 区块外词条 | 托管区块外的合法词条定义，只读 |

## Markdown 词条

### 标签

词条标签的完整规则是：

```regex
^w-([a-z]+(?:['-][a-z]+)*)$
```

捕获部分是 lemma。lemma 使用小写 ASCII 英文字母，内部可以包含 ASCII 撇号 `'` 或连字符 `-`。`go`、`can't` 和 `mother-in-law` 合法；`Go`、`go2`、`-go`、`go--home` 和排印撇号不合法。

正文引用紧跟词形：

```markdown
went[^w-go] and goes[^w-go]
```

同一 lemma 的多处引用共用一条定义。代码块、行内代码和转义后的字面量不作为引用处理。

### 定义

定义必须是单个物理行：

```markdown
[^w-go]: {"word":"go","translation":"去","example":"She went home."}
```

定义只有在以下条件同时成立时才是词条：

1. 标签严格匹配 `w-lemma`；
2. 归一化后的标签只有一个定义；
3. 冒号后的同一物理行可以被 `JSON.parse` 完整解析；
4. 解析结果是有限、可序列化的 JSON 值。

JSON 根值可以是对象、数组、字符串、有限数字、布尔值或 `null`。标签中的 lemma 是词条身份；对象内的 `word` 字段没有身份语义。默认录入表单生成 `word`、`translation`、`example` 三个字符串字段，自定义模板不受该对象形状限制。

### 托管区块

标记必须作为顶层 HTML 注释各占一行：

```markdown
<!-- caretlex:vocab:start -->
[^w-go]: {"word":"go","translation":"去","example":"She went home."}
<!-- caretlex:vocab:end -->
```

一篇文档最多包含一对标记。开始标记位于结束标记前，开始标记带行尾，结束标记后只允许空白。区块内部只允许空行和合法的单行 `w-lemma` 定义。

应用创建或更新区块时按 lemma 的 ASCII 字典序排列定义，使用 `JSON.stringify` 生成定义值，并使用文档中检测到的第一种换行符。区块外内容不经过 Markdown 序列化。空区块保留两条标记。

### 完整示例

```markdown
# A short trip

She went[^w-go] to school. He goes[^w-go] home.
A note[^1] remains an ordinary footnote.

[^1]: This is a normal note.

<!-- caretlex:vocab:start -->
[^w-go]: {"word":"go","translation":"去","example":"She went to school."}
<!-- caretlex:vocab:end -->
```

普通 GFM 阅读器把 `w-` 引用当作普通脚注。CaretLex 阅读视图隐藏有效词条的脚注编号和定义，并把相邻原文词形渲染为词条锚点。

## 诊断与可写性

| 文档状态 | 读取行为 | 词条写入与导出 |
|---|---|---|
| 合法托管定义 | 建立词条和引用索引 | 允许 |
| 合法区块外定义 | 建立只读词条 | 不允许编辑、删除或创建同 lemma 托管定义 |
| 区块外定义的 JSON 无效 | 作为普通脚注并显示 warning | 文档其他词条仍可写；同 lemma 存词因定义冲突被拒绝 |
| 托管区块含无效 JSON 或未知非空行 | 保留原文并显示 error | 整篇文档的词条写入和导出关闭 |
| `w-` 定义按 GFM 标识符归一化后重复 | 不选择其中一条作为词条 | 整篇文档的词条写入和导出关闭 |
| 标记缺失、重复、逆序或不在文末 | 保留原文并显示 error | 整篇文档的词条写入和导出关闭 |
| 没有托管区块 | 按普通 Markdown 阅读 | 允许添加词条；导出 `{}` |

阻断状态只影响词条添加、编辑、删除和导出。源码模式仍可保存用户明确编辑的完整文档。

## 词条操作

添加操作要求选区仍能唯一映射到当前 Markdown 中的完整英文单词，并要求磁盘 revision 与选择时一致。

- 新 lemma：在选词末尾插入引用，并新增定义；没有区块时在文末创建区块。
- 已有托管 lemma：只插入引用，定义值保持不变。
- 相同引用已经紧邻选词：返回无变化结果。
- 另一条 `w-` 引用已经紧邻选词：拒绝操作。
- 编辑：用完整的新 JSON 值替换托管定义，并重新输出排序后的托管区块。
- 删除：移除托管定义及所有 mdast 中真实匹配的引用，保留原文词形。

词条操作生成互不重叠的源码补丁，不使用 Markdown 全文 stringify。文档 BOM 保持不变；托管区块以外未触及的文本和换行保持不变。

## 设置 JSON

设置文件是 UTF-8 JSON，schema 版本为 1。默认内容是：

```json
{
  "version": 1,
  "theme": "system",
  "providers": ["manual"],
  "entryTemplate": {
    "word": "",
    "translation": "",
    "example": ""
  },
  "bindings": {
    "/word": {"from": "lemma"},
    "/translation": {"from": "manual", "label": "中文翻译", "required": true},
    "/example": {"from": "sentence"}
  }
}
```

字段规则：

- `version` 固定为 `1`；
- `theme` 是 `system`、`light` 或 `dark`；
- `providers` 严格为 `["manual"]`；
- `entryTemplate` 是任意 JSON 值；
- `bindings` 的键是指向模板中现有位置的 RFC 6901 JSON Pointer；空字符串指向根值；
- 绑定路径之间不能存在祖先/子孙重叠。

绑定来源如下：

| `from` | 写入值 | 额外字段 |
|---|---|---|
| `selected` | 阅读视图中的原文词形 | 无 |
| `lemma` | 用户确认的 lemma | 无 |
| `sentence` | 选词所在句子或文本块 | 无 |
| `manual` | 录入卡中的手动文本 | 可用 `label` 和 `required` |
| `constant` | 设置中给出的固定 JSON 值 | 必须有 `value` |

无效 JSON、未知 schema 版本、未知 provider、失效 JSON Pointer、重叠绑定和错误字段类型都会拒绝保存。设置文件上限为 1 MiB。

## 导出 JSON

导出只包含当前文档有效托管区块中的词条。输出是没有尾随换行的单行 UTF-8 JSON 对象，键按 lemma 的 ASCII 字典序排列，值保持完整 JSON 类型：

```json
{"go":{"word":"go","translation":"去","example":"She went to school."}}
```

空区块或不存在区块时输出 `{}`。区块外词条不参与导出。阻断诊断存在时拒绝导出。导出文件不作为应用数据源，修改导出文件不会修改 Markdown。

## 文件级约束

- Markdown 必须是严格 UTF-8，可以带 UTF-8 BOM，大小不超过 16 MiB；
- 源码范围使用去除文件 BOM 后的 UTF-16 偏移；
- 文档 revision 是包含 BOM 的原始字节 SHA-256；
- 单个 IPC 词条值序列化后不超过 1 MiB；
- 保存使用同目录临时文件和原子 rename，并在提交前比较 revision；
- revision 冲突保留内存草稿，不覆盖磁盘文件。
