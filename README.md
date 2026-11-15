# dsh-shot

给 DeepSeek Harness 输入框加一个截图按钮：点一下 → 整屏变暗 → 拖拽框选 → 确认，框到的画面直接成为当前会话的图片附件。

版式参照豆包/微信的截图工具：顶部「截图提问」胶囊、右上 ESC 与取消、白色虚线选区 + 8 个圆形手柄、尺寸浮标、选区下方「复制 / 取消 / 确认」，并额外提供标注工具（矩形、椭圆、箭头、画笔、文字、马赛克、撤销重做）。

- 仅 Windows（截屏走 GDI）
- 输入框左侧独立按钮，无快捷键占用
- 截图质量与屏幕逐像素一致：预览按设备像素绘制，交付 PNG 不做任何缩放

## 安装

插件由两半组成：host 半（`index.js`，负责真的抓屏）与 client 半（`client.js`，负责按钮与框选遮罩）。

1. 取回代码并放进任意目录，例如 `D:\plugins\dsh-shot`。
2. 在 DSH profile 的 `package.json`（`C:\Users\<you>\.dsh\profiles\<profile>\package.json`）里加依赖与 bundle：
   ```jsonc
   "dependencies": { "dsh-shot": "link:D:/plugins/dsh-shot" },
   "dsh": { "profile": { "bundles": [ /* … */ "dsh-shot" ] } }
   ```
3. 让 `node_modules` 里能解析到它。没有 pnpm 时用目录联接（管理员权限的 cmd 里 `mklink /J` 也可以）：
   ```powershell
   New-Item -ItemType Junction `
     -Path   "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-shot" `
     -Target "D:\plugins\dsh-shot"
   ```
4. 用 `plugin_manager` 打开：`set_bundle(target="dsh-shot", enabled=true)`。它会把插件 import 进运行中的 composition，host 半立即生效。
5. **client 半需要重启桌面端**（生产构建没有重载渲染进程的入口，见下文）。重启后输入框左侧出现相机图标。

改过 `client.js` 之后要连做三步：`set_bundle(false)` → `set_bundle(true)` → 重启 DSH。只重跑 `enabled=true` 会返回 `changed:false`，因为组合体的字节已在 graph 重建时进了内存缓存，而渲染进程的 URL rev 由文件 `mtime` 推导，不重启就拿不到新字节。

## 用法

| 操作 | 效果 |
| --- | --- |
| 点相机按钮 | 抓屏并进入框选 |
| 拖拽 | 画出选区（可拖动选区、拖 8 个手柄缩放） |
| `R` `O` `A` `P` `T` `M` | 矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 马赛克 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Enter`、双击选区内、点「确认」 | 裁剪并放进输入框 |
| `Esc`、右键、点「取消」 | 退出，不产出图片 |
| 右键相机按钮 | 切换「截屏时隐藏本窗口」（默认开，存 `localStorage`） |

「复制」把结果写进剪贴板（桌面端剪贴板权限被拒时会改为下载文件）。

## 为什么需要 host 半

桌面端主进程在 `configureSession` 里把渲染进程的 `display-capture`、`clipboard-read` 等权限一律拒绝（`setPermissionRequestHandler` 回 false，`setDisplayMediaRequestHandler` 回空对象），所以页面里拿不到 `getDisplayMedia`，纯前端截屏这条路封死。

截屏因此交给操作系统：host 半用 PowerShell + GDI `CopyFromScreen` 抓整个虚拟桌面，PNG 在内存里编码后回传，不落任何临时文件。抓屏带上 `x-dsh-screen-width/height/origin-x/origin-y` 响应头，前端据此把选区换算回物理像素，裁剪时从原图取原生像素。

「隐藏本窗口」打开时，host 先把 DSH 窗口最小化 → 抓屏 → 最大化，界面结束后按存下的几何还原（原本最大化就回最大化），并用 `SetWindowPos` + `GetWindowRect` 复核兜底。

## 截图怎么进输入框

不走替换 slot、也不调上传接口，而是复用官方已有的两条入口：

1. 合成 `ClipboardEvent('paste')`（`clipboardData` 是塞了 `File` 的 `DataTransfer`）——`createComposerFileIntake` 在 document 上监听 paste，取文件后交给当前 composer；
2. 失败再合成 `dragenter/dragover/drop` —— `installDocumentDropEvents` 只要 `dataTransfer.types` 含 `Files` 就收。

两条路都不检查 `isTrusted`。注入后看草稿栏里 `img[src^="blob:"]` 是否出现来确认真的进去了；没进去会弹提示，不静默失败。

输入框忙的时候（正在生成回复、会话被锁、附件上传被禁用），`intakeFiles` 会直接 `return`，连 toast 都没有。所以注入前先看 paste 事件是否被 `preventDefault`（只有挑到目标 composer 才会），被拒就每 700 ms 重试、最多等 5 分钟，并提示「等这条回复结束会自动把截图贴进去」。

## 清晰度：预览按设备像素画

若把 2560×1600 的截图按 CSS 像素铺在 1700×1067 的画布后备区上，浏览器会再按 `devicePixelRatio`（本机 1.5）合成放大——先缩一次再放一次，两次重采样，预览发糊。

现在：`scale = min(视口宽/图宽, 视口高/图高, 1/devicePixelRatio)`；画布后备区取 `shownWidth × dpr`、CSS 尺寸仍取 `shownWidth`。于是「截屏尺寸 = 屏幕尺寸」时画布 1 像素正好对上 1 个物理像素，零重采样；裁剪用 `imageSmoothingEnabled = false` 从原图取原生像素。

## 已知边界

- 只支持 Windows；其它平台路由返回 500 并说明不支持。
- 单次抓屏约 1–4 s（冷启动要编译 C# 声明），按钮在抓图期间是 busy 态。
- 多显示器时抓整个虚拟桌面，框选坐标按 `origin-x/origin-y` 对齐。
- 「+」菜单是 shipped UI，没有可注入的条目 slot，所以入口是输入框左侧的独立按钮。

## 开发笔记（踩过的坑）

- 插件挂 `dsh.client` 时，`client.js` 必须是 `window.__ModuleLoader__.load({ id, factory })` 形态，工厂返回 `{ inject, apply }`，且 `id` 必须等于包名（宿主按 `record.entry.id` 查表）。
- client 半是纯 DOM + React 混用：`apply()` 里若抛错，slot 注册整体回滚、按钮无声消失。排查时先把错误写进宿主日志再看，不要猜。
- slot 占用者是 React 组件，往里塞 `document.createElement` 造的节点会抛 `Objects are not valid as a React child`——用 `dangerouslySetInnerHTML` 包一层。
- 框选遮罩若在 `pointerdown` 里无条件 `setPointerCapture`，工具栏/确认条上的点击会被读成「重新框选」，按钮永远点不动。命中 `button`/`input` 时要提前返回。
- host 半是纯 ESM JavaScript：写成 `.js` 就不能带 TS 类型注解。
- 给 PowerShell 喂多行脚本**不要用** `-Command -` + stdin：带 here-string 的脚本会静默不执行、退出码 0、stdout 全空。用 `-EncodedCommand`（UTF-16LE base64）。
- 任何调用 `SetWindowPos` 的脚本都要先 `SetProcessDpiAwarenessContext(-4)`，否则 150% 缩放下坐标会被再放大一次（窗口「变大了」的经典原因）。
- GDI 的 `Bitmap.Save` 覆盖同名文件会抛 `GDI+ 中发生一般性错误`（文件被占用）。

## 许可

MIT