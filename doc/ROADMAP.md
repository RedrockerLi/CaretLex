# 实施顺序与未完成事项

> 状态：首版实施记录（2026-09-23）。第 0 至第 2 阶段的核心实现和包内窗口冒烟通过；第 3 阶段部分完成。AppImage 与使用 `example.invalid` 占位元数据的测试 deb 均已生成并通过包内窗口冒烟。测试 deb 不可发行或分发；真实项目主页、Debian maintainer 信息、系统安装验收和浏览器内 Logo 预览检查仍待完成。产品与协议见 [PRODUCT.md](PRODUCT.md) 和 [PROTOCOL.md](PROTOCOL.md)。

下列阶段记录实际交付和验收范围。没有通过的门槛明确列在末尾，不用相似结果代替。

## 第 0 阶段：解析与选词定位 — 已完成

- `src/shared/protocol.ts` 使用 `remark-parse + remark-gfm` 构造带源码范围的 AST、脚注索引和诊断，覆盖普通脚注、`[^w-]` 引用、多引用、重复定义、区块外定义和任意 JSON 值。
- Vitest 检查段落、标题、列表、引用、表格及强调文本中的源码范围；重复词、转义、字符实体、UTF-16、BOM、CRLF 和混合换行都有用例。代码、链接、多词、跨节点和不能证明唯一源码范围的选区会拒绝。
- 打包窗口测试使用真实 DOM 选区，选择重复英文词的指定出现位置并检查写入目标。

## 第 1 阶段：协议与文件引擎 — 已完成

- `src/shared/patch.ts` 负责托管区块、增删改和导出；词条补丁只改目标引用与托管定义。共享测试验证任意 JSON 值、坏区块、重复定义、只读区块外定义和同位置无操作。
- 文件仓储以原始文件 SHA-256 revision 做写前比较，使用同目录临时文件和原子替换，并保留 BOM、换行及未触及字节。设置仓储支持 UTF-8 JSON、同步目录迁移、本机路径指针、版本冲突和外部修改监听。
- 本地图片只可从当前 Markdown 所在目录及其子树读取；路径越界、真实路径越界、符号链接越界和超大文件都拒绝。远程图片需用户单次主动加载。
- 共享核心与仓储测试共 27 项，包含成功迁移后重新打开设置路径、外部版本冲突、损坏设置不被默认值覆盖、导出路径符号链接识别和写入串行化。

## 第 2 阶段：桌面阅读与录入 — 核心闭环已验收

- 已实现 Electron 主进程和隔离 preload、Vue 3/Pinia 阅读界面、CodeMirror 6 源码模式、多标签、亮暗主题、手动词条表单、完整 JSON 编辑、悬停卡、词条编辑/删除、设置页与当前文档导出。
- `tests/integration/packaged-smoke.mjs` 在打包 Electron 程序内打开真实 Markdown 文件，验证指定位置新词、同 lemma 另一处复用、重复点击字节不变、悬停卡编辑、删除全部引用、重加、源码显式保存、应用重开与词条恢复。
- 设置迁移由仓储测试覆盖；JSON 导出的排序、完整值和坏区块拒绝由核心测试覆盖。原生导出保存对话框和设置迁移选择对话框尚未通过包内 UI 验收。本环境用 Xvfb 和宿主 XWayland 尝试时，Electron 原生文件选择器未能稳定显示并完成键盘自动化；不能据数据层测试宣称 UI 路径通过。
- 原始 HTML 作为转义源码显示，不执行。图片、外链和 IPC 均由主进程限制；具体约束见 [架构说明](ARCHITECTURE.md)。

## 第 3 阶段：品牌与 Linux 发行 — 部分完成

- `branding/caretlex/` 已包含 A/B/C 预览、以 B 为起点的正式 SVG、可编辑字标、离线预览页、说明文档及 Linux PNG 图标派生脚本。XML、`viewBox`、字体和外部资源检查及 librsvg 多尺寸栅格检查通过。
- 当前环境无法启动 Chrome headless（Crashpad 报 `setsockopt: Operation not permitted`），故未在浏览器中打开预览页截图检查。限制与栅格检查记录见 [品牌 README](../branding/caretlex/README.md)。
- `npm run dist:linux` 生成 Linux x64 AppImage 与测试 `.deb`。测试包使用 `https://example.invalid/caretlex` 和 `CaretLex Placeholder <maintainer@example.invalid>`，`dpkg-deb -I` 已核对控制字段；这些占位数据不是项目主页或真实维护者身份，测试 deb 不可发行或分发。配置包含 electron-builder 的默认 Debian 运行依赖及 X11 补充依赖。
- AppImage 和从 `.deb` 解包出的 `/opt/CaretLex/caretlex` 均通过真实窗口存词、复用、编辑/删除、源码保存和重开冒烟。未在干净系统中安装该 deb；解包运行不能替代安装验收。

## 本轮验证结果

以 Node 22.23.2 执行：

```sh
npm ci
npm run typecheck
npm test -- --reporter=dot
npm run build
npm run dist:linux
env -u WAYLAND_DISPLAY xvfb-run -a node tests/integration/packaged-smoke.mjs dist/CaretLex-0.1.0-x86_64.AppImage
smoke_dir="$(mktemp -d)"
dpkg-deb -I dist/CaretLex-0.1.0-amd64.deb
dpkg-deb -x dist/CaretLex-0.1.0-amd64.deb "$smoke_dir"
env -u WAYLAND_DISPLAY xvfb-run -a node tests/integration/packaged-smoke.mjs "$smoke_dir/opt/CaretLex/caretlex"
rm -rf "$smoke_dir"
```

干净依赖安装、类型检查、生产构建、27 项 Vitest 以及 Linux x64 AppImage 和 deb 构建通过。最终 AppImage 和 deb 解包后的程序均通过打包窗口中的存词、同词复用、编辑、删除、源码保存与重开冒烟。`dpkg-deb -I` 确认 deb 含 `.invalid` 占位主页和维护者信息及所需依赖；测试 deb 尚未系统安装。浏览器 Logo 截图、设置迁移对话框和导出对话框的实际 UI 操作未验证。设置迁移和导出数据内容由仓储与核心测试覆盖。

## 剩余验收与后续事项

- 用真实项目主页和 Debian maintainer 姓名/邮箱替换 `.invalid` 占位字段，重建正式 `.deb`，并在干净的受支持 Linux 系统中安装后做冒烟验收。
- 在可用浏览器中打开 `branding/caretlex/logo-preview.html`，检查 16/24/32/48/128/256px 并保存截图。
- 在有可用文件选择器的 Linux 桌面会话中，通过打包应用的原生对话框实际操作设置迁移和词条 JSON 导出；数据层已有仓储与核心测试覆盖，原生对话框路径尚未实测。
- 设置页可视化 JSON 树、更多 provider、旧词条迁移、短语及其他阅读语言、自动词形还原、由导出 JSON 重建 Markdown 词条、文件夹级扫描、复习/统计/发音、Windows/macOS 发行、文件树和所见即所得编辑。
