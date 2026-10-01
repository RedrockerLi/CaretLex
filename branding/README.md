# CaretLex 品牌资产

本目录保存 CaretLex 的正式 SVG、Linux PNG 图标、离线预览页和派生工具。品牌图形来自词条标签 `[^w-lemma]` 的固定前缀 `[^w-]`：方括号表示 Markdown 语法容器，caret 是视觉中心，`w-` 表示词条命名空间。

## 视觉系统

正式图标采用紧凑的几何 `[^w-]`。左右方括号共享镜像骨架，caret 使用强调色，`w-` 保持小尺寸可辨识性。应用图标的坐标系是 `128 × 128`，横向标的坐标系是 `580 × 160`。

字标固定写作 `CaretLex`，基于 Inter SemiBold 600 的轮廓。正式横向 SVG 使用 path，不依赖运行环境字体；`logo-wordmark-editable.svg` 保留文本字标，只作为编辑源。

| 名称 | 色值 | 用途 |
|---|---|---|
| Ink | `#171C26` | 深色背景、浅色版主体、深墨单色版 |
| Slate | `#96A1B2` | 深色版方括号 |
| Paper | `#F4F6F8` | 浅色背景、深色版主体、浅色单色版 |
| Amber | `#E2B35D` | 深色版 caret 与 `Lex` |
| Amber on light | `#9A6500` | 浅色版 caret 与 `Lex` |

正式 SVG 的颜色定义在文件内部，不引用页面 CSS、远程资源或外部图片。

## 文件清单

| 文件 | 用途 |
|---|---|
| `logo-horizontal-dark.svg` | Ink 背景的横向 Logo |
| `logo-horizontal-light.svg` | Paper 背景的横向 Logo |
| `logo-icon-dark.svg` | 深色背景的完整应用图标 |
| `logo-icon-light.svg` | 浅色背景的完整应用图标 |
| `logo-icon-transparent.svg` | 适合浅色背景的透明图标 |
| `logo-monochrome-dark.svg` | 适合浅色背景的深墨单色横向标 |
| `logo-monochrome-light.svg` | 适合深色背景的浅色单色横向标 |
| `favicon.svg` | 16–48px 使用的简化 `[^]` 图形 |
| `app-icon.png` | electron-builder 使用的 512px Linux 图标 |
| `app-icon-128.png` | 128px PNG 图标 |
| `app-icon-256.png` | 256px PNG 图标 |
| `app-icon-512.png` | 512px PNG 图标 |
| `logo-wordmark-editable.svg` | 依赖 Inter SemiBold 的文本字标编辑源 |
| `logo-preview.html` | 无网络依赖的资产与尺寸预览页 |

`logo-preview.html` 同时包含三种同方向造型对照，并展示正式资产。正式图标使用 Geometric 造型。预览页通过相对路径加载本目录文件，可以直接用浏览器打开。

## PNG 派生

`tools/export-png-icons.py` 从 `logo-icon-dark.svg` 生成 128、256 和 512px PNG。脚本需要 Python 3、librsvg-2、Cairo 和 GObject：

```sh
python3 tools/export-png-icons.py
```

脚本读取 SVG 内的 CSS 色值，在临时副本中展开变量后栅格化，不修改 SVG 源文件。`app-icon.png` 与 `app-icon-512.png` 使用相同图像内容。

## 字标轮廓

`tools/outline-wordmark.c` 使用 FreeType 输出横向标需要的字形 path。环境需要 Inter SemiBold 字体、FreeType 开发头文件和 `pkg-config`：

```sh
gcc -O2 $(pkg-config --cflags freetype2) tools/outline-wordmark.c \
  -o /tmp/caretlex-outline-wordmark $(pkg-config --libs freetype2)
/tmp/caretlex-outline-wordmark /path/to/Inter-SemiBold.otf 78 180 107 5
```

参数依次是字体路径、字号、水平位置、基线，以及 `Caret` 与 `Lex` 的分色位置。输出使用 `--wordmark-primary` 和 `--wordmark-accent` 两个 CSS 属性。

Inter 字体由 [rsms/inter](https://github.com/rsms/inter) 提供，采用 SIL Open Font License 1.1。

## 使用约束

- 128px 及以上应用图标使用完整 `[^w-]`；小尺寸 favicon 使用 `[^]`；
- 深色背景使用深色横向标或浅色单色标，浅色背景使用浅色横向标、透明图标或深墨单色标；
- 不拉伸、重排或拆分字符顺序；
- 正式 SVG 不替换为依赖字体的编辑源；
- PNG 是 Linux 打包派生物，SVG 是品牌源资产。
