# 文件协议

CaretLex 将词条保存在标准 Markdown 脚注中。协议核心位于 `src/shared/protocol.ts`、`patch.ts`、`settings.ts`、`mapping.ts` 和 `entries.ts`。

## Markdown 与身份

标签为 `w-lemma`，lemma 使用小写 ASCII 英文字母，允许内部 ASCII 撇号或连字符，IPC 长度上限 128：

```regex
^w-([a-z]+(?:['-][a-z]+)*)$
```

正文真实词形保持原值，引用紧邻词形；同 lemma 的多个引用共用一个定义。定义值由 `JSON.stringify` 输出为单个物理行：

```markdown
The bank[^w-bank] is beside the river bank[^w-bank].

<!-- caretlex:vocab:start -->
[^w-bank]: {"lemma":"bank","contexts":[{"original_sentence":"The [bank] is beside the river bank.","meaning_in_context":"（名词）银行","english_definition":"a financial institution"},{"original_sentence":"The bank is beside the river [bank].","meaning_in_context":"（名词）河岸","english_definition":"land beside a river"}],"other_meanings":[]}
<!-- caretlex:vocab:end -->
```

托管标记是各占一行的顶层 HTML 注释，一篇文档最多一对，位于文末，结束后仅允许空白。区块内部只允许空行和合法单行 `w-lemma` JSON 定义。写入按 lemma 排序，使用文档首个换行形式。代码、转义字面量与普通脚注保留。

通用 JSON 根值可以是对象、数组、字符串、有限数字、布尔值或 null。默认对象含根级 lemma、成对的 contexts 和 other_meanings；保存过的根级 lemma 与脚注身份保持一致，不能修改或删除。自定义/旧结构不自动转换；自动 contexts 合并和当前语境摘要只识别默认结构。

添加总是采用用户确认的完整最终值。已有同名定义也更新值，同位置相同引用允许更新定义；只有引用和定义均无变化才 no-op。其他词条引用不可叠加。区块外定义只读，重复归一化定义、非法托管 JSON 或损坏标记阻止词条操作与导出。源码编辑可用于人工修复。

## Article 与 contexts

article 包含 `original_word` 与 `original_sentence`。原词保留真实大小写、词形；原句按选区 UTF-16 映射位置插入一对方括号，已有括号保留。marker 仅存在于来源数据和保存 JSON，不改变正文。

自动合并复制已有完整值，只按 `original_sentence` 的完整字符串追加 contexts。相同 key 保留原 context，包括人工释义。other_meanings 和其他根字段保留，不做语义去重。无法识别的结构明确失败，由用户整理最终 JSON。主进程保存时不再次合并。

## 设置

```json
{
  "theme": "system",
  "providers": [],
  "saveTemplate": {
    "lemma": "",
    "contexts": [{"original_sentence": "article.original_sentence", "meaning_in_context": "", "english_definition": ""}],
    "other_meanings": []
  }
}
```

provider 实例为 `{name, type, enabled, config}`。name 为区分大小写的 `[A-Za-z_][A-Za-z0-9_-]*`，必须唯一，article 保留。type 必须注册；最多一个实例启用。手动填写是编辑流程，不是 provider。

`LLM` config 包含 `apiType`、`baseUrl`、`model`、可选 `apiKeyRef`、`prompt`、`responseTemplate`、`jsonMode`、`timeoutMs` 和 `maxOutputTokens`。默认 API 类型为 `openai-chat`，地址、模型为空，JSON mode 关闭，超时 60000 ms，最大输出 tokens 为 4096。停用配置可未填写完整地址/模型；启用需合法 HTTP/HTTPS 基础地址与非空模型。timeoutMs 和 maxOutputTokens 为 1–2147483647 的整数。Base URL 不含用户认证、查询或片段。

prompt 支持 `{{article.original_word}}`、`{{article.original_sentence}}` 与 `{{JSON}}`。`{{JSON}}` 展开为当前实例 responseTemplate 的 JSON 文本，使用两空格缩进；默认 prompt 包含此变量。所有变量均一次字面替换，不递归求值。不支持的变量报错。响应示例声明对象必有字段及其类型；额外字段允许，数组样例声明统一元素结构，长度不限。空数组不声明元素内部格式，null 只声明 null 类型。检查不验证语义。

普通设置快照包含路径、原始文本、原始字节 revision、可选已解析值、错误和恢复 token。可解码的非法文件可按原始 revision 重写；普通保存拒绝无法安全解码或超限的原文件。用户点击“恢复默认设置”时，主进程校验绑定当前文件与路径指针字节的 token 后原子写入默认配置；该显式操作可以替换无法解析、无法解码或超限的配置。损坏的路径指针恢复为本机默认设置路径。冲突不覆盖，凭据文件保留。

## 保存映射

来源命名空间为 article 与实际启用实例 name。字符串中的完整来源路径读取 JSON；返回数据复制后不再次作为模板执行。

| 示例 | 行为 |
|---|---|
| `article.original_sentence` | 本地标记原句 |
| `llm_main.lemma` | 来源字段 |
| `llm_main.other_meanings[].meaning` | 展开列表、读取每项字段 |
| `llm_main.other_meanings[0].meaning` | 指定下标 |
| `llm_main.other_meanings` | 复制完整 JSON 子树 |
| `{"$literal": ...}` | 内部值不求值 |
| 其他普通 JSON 值 | 保留字面量 |

动态输出数组只能有一个元素模板，并且只能展开一个来源列表。同列表字段共享当前下标，标量可广播；源列表为零项时输出 `[]`。嵌套数组需明确对应层级，不 zip、不拼接、不平铺、不猜测多个列表关系。固定数组逐项实例化。第一版路径字段为可引用标识，复杂字段名可整体引用父 JSON 子树。

缺失字符串字段由响应示例确定类型，填 `""` 并诊断；不可用展开列表输出 `[]`；其他缺失值用 null。错误行保留行数与其他合法字段。完整子树绑定存在结构错误时用 null 待手填，不执行未配置修补。合法 null、空数组与缺失字段分别识别。来源路径不会作为未解析绑定直接写入。

## LLM HTTP 与凭据

API 类型决定协议，基础路径保留，尾部 `/` 去除后追加表中端点，不自动添加版本路径。生产使用真实 HTTP POST，非流式输出；所有请求均含本地替换后的 Prompt 和响应 JSON 示例说明。

| apiType | 追加端点 | 请求与认证 | JSON mode | 响应文本 |
|---|---|---|---|---|
| `openai-chat` | `/chat/completions` | model、messages、max_completion_tokens、stream: false；Bearer Key | response_format.type = json_object | choices[0].message.content，finish_reason = stop |
| `openai-responses` | `/responses` | model、instructions、input、max_output_tokens、stream: false；Bearer Key | text.format.type = json_object | completed output 中 message.content 的 output_text |
| `anthropic-messages` | `/messages` | model、system、messages、max_tokens、stream: false；x-api-key，anthropic-version = 2023-06-01 | 不提供；Prompt 请求 JSON | assistant message 的 text，stop_reason = end_turn |
| `gemini` | `/models/{model}:generateContent` | systemInstruction、contents、generationConfig.maxOutputTokens；x-goog-api-key | generationConfig.responseMimeType = application/json | candidates[0].content.parts.text，finishReason = STOP |

协议依据官方 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[Gemini Generate Content](https://ai.google.dev/api/generate-content) 与 [Gemini API Key](https://ai.google.dev/gemini-api/docs/api-key)。Gemini 模型可带 `models/` 前缀，模型名称只允许字母、数字、下划线、点和连字符。

只接受成功 HTTP、严格 UTF-8 外层 JSON 和协议声明位置的纯 JSON 文本。拒绝空内容、拒绝/过滤、截断和工具调用；协议声明的 reasoning/thinking 内容不参与 JSON 解析。不自动重试、修补或切换接口。JSON mode 不能代替本地字段检查，兼容服务需自行支持所选协议和参数。

凭据位于本机用户数据目录 `credentials.json`，内容为稳定 `key-UUID → Key` 的明文映射，原子写入权限 0600。新 Key 创建新引用，旧记录保持有效。配置和 IPC 凭据状态只含引用或存在性，不返回 Key。没有引用才匿名请求，有引用缺失则失败。损坏文件保留字节。`credentials.json` 与 `settings-path.json` 禁止作为设置路径。

## 文件与资源限制

- Markdown 严格 UTF-8，可含 BOM，上限 16 MiB。
- SourceSpan 是不计文件 BOM 的 UTF-16 左闭右开源码范围。
- revision 是含 BOM 原始字节的 SHA-256。
- 设置、单词条 JSON、AI 请求体及响应体各上限 1 MiB，按实际字节检查。
- 保存绑定编辑开始时的 documentId、baseRevision 和真实选区，禁止按当前标签推断目标。
- 同目录临时文件 fsync，提交前检查 revision，原子 rename 保留 BOM 和未触及正文。
- 冲突、取消或超限保留内存稿件，不截断，不宣告成功。

导出为单行 UTF-8 `lemma → 完整值` 对象，按 lemma 排序，只含当前文档托管词条；空区块为 `{}`。
