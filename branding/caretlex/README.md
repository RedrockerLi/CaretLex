# CaretLex 品牌资产

## 定稿

定稿以 **B · Geometric** 为基础。A 的字符分隔最直观，但笔画层级较弱；C 的笔画较厚，内部空隙在缩小后容易挤在一起。B 在方括号对称、caret 主次、`w-` 的可读性和整体重心之间更平衡。主图标按同一几何顺序绘制完整的 `[^w-]`；仅 favicon 在 16–48px 使用 `[^]` 简化图形。

主图标使用 `128 × 128` viewBox。符号左右各保留约 18px 以上、上下各保留约 36px 以上的安全距离。横向标为 `580 × 160`，图标与字标沿同一水平中心线排列。图形以几何路径绘制，不依赖系统字形或页面样式。

## 色彩

| 名称 | 色值 | 用途 |
|---|---|---|
| Ink | `#171C26` | 深色背景、浅色版主体字形、深墨单色 |
| Slate | `#96A1B2` | 深色版方括号 |
| Paper | `#F4F6F8` | 浅色背景、深色版主体字形、浅色单色 |
| Amber | `#E2B35D` | 深色版 caret 与 `Lex` |
| Amber on light | `#9A6500` | 浅色版 caret 与 `Lex` |

全部正式 SVG 将颜色声明在自身的 `:root` CSS 自定义属性中，几何由 SVG 原生路径组成，无外链资源。透明标适合浅色背景；单色深墨标适合浅色背景，单色浅色标适合深色背景。

## 文件

- `logo-preview.html`：A / B / C 候选及全部正式资产的离线预览页；只引用本目录文件。
- `logo-horizontal-dark.svg`、`logo-horizontal-light.svg`：深浅底横向标。字标已经转成 SVG path。
- `logo-icon-dark.svg`、`logo-icon-light.svg`：深浅底完整 `[^w-]` 应用图标。
- `logo-icon-transparent.svg`：透明底完整图标，适合浅色背景。
- `logo-monochrome-dark.svg`、`logo-monochrome-light.svg`：透明底单色横向标。
- `favicon.svg`：用于浏览器页签的小尺寸 `[^]` 图形。
- `logo-wordmark-editable.svg`：使用文本保留的编辑源，要求本机安装 Inter SemiBold；不能代替正式路径版。
- `app-icon.png`：Linux 打包用 512px PNG，与 `app-icon-512.png` 相同。
- `app-icon-128.png`、`app-icon-256.png`、`app-icon-512.png`：从 `logo-icon-dark.svg` 确定性导出的 PNG 尺寸。

## 字标字体与路径来源

字标使用 **Inter SemiBold 600**。Inter 源码和字体文件见 [rsms/inter](https://github.com/rsms/inter)，字体依 SIL Open Font License 1.1 发布。正式 SVG 不嵌入字体；`tools/outline-wordmark.c` 使用 FreeType 的字体轮廓接口生成字形 path，并保留字符间的 kerning。编辑源仍保留为 Inter 文本。

在安装了 Inter SemiBold、FreeType 开发头文件和 `pkg-config` 的环境，可按下列方式生成横标使用的 `<g>` 路径片段：

```sh
gcc -O2 $(pkg-config --cflags freetype2) tools/outline-wordmark.c \
  -o /tmp/caretlex-outline-wordmark $(pkg-config --libs freetype2)
/tmp/caretlex-outline-wordmark /path/to/Inter-SemiBold.otf 78 180 107 5
```

参数依次为字体、字号、水平位置、基线和 `Caret` / `Lex` 的分色位置。输出片段使用 `--wordmark-primary` 与 `--wordmark-accent` 两个 CSS 属性；横标 SVG 在本地声明这两个属性。

## PNG 导出与使用

在提供 `librsvg-2`、Cairo 和 GObject 运行库的 Linux 环境运行：

```sh
python3 tools/export-png-icons.py
```

导出脚本读取 `logo-icon-dark.svg` 内的 CSS 色值，在临时副本中展开变量后调用 librsvg / Cairo 栅格化；SVG 源文件本身保持 CSS 自定义属性形式。Electron Linux 构建可使用 `app-icon.png`，或根据打包器的尺寸需求选用 `app-icon-256.png` / `app-icon-512.png`。小尺寸 favicon 使用单独的 `favicon.svg`，不缩小完整图标。

## 检查记录与限制

- 用 XML 解析逐个检查正式 SVG 文件结构与 `viewBox`；横标包含路径字标，没有 `<text>`、外部字体、图片或远程资源。预览 HTML 仅以相对路径加载本地文件。
- 用 librsvg / Cairo 检查深浅横标、透明标、单色标及图标 SVG 的独立渲染，并在 16、24、32、48px 实际栅格尺寸查看 favicon；在 128、256、512px 检查应用图标。调整 B 后确认 caret、`w` 与连字符有清楚间距，左右括号对称，路径无裁切。
- 当前受限运行环境无法启动 Google Chrome：headless 进程在 Crashpad 初始化时以 `setsockopt: Operation not permitted` 退出，内置浏览器也不可用。因此**本轮没有完成在浏览器中打开 `logo-preview.html` 并截图的人工检查**；预览页离线显示效果仍需在可用浏览器环境中确认。librsvg 的检查在临时副本中展开 CSS 变量以供栅格化，交付 SVG 中的变量声明保留原样。
