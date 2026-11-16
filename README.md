# dsh-shot

Screen capture for the DeepSeek Harness composer — press a camera button, drag a frame, and the crop lands in the draft as a prompt image. The same move Doubao and QQ give you, added to DSH itself.

给 DeepSeek Harness 输入框加一个截图按钮：点一下 → 整屏变暗 → 拖拽框选 → 确认，框到的画面直接成为当前会话的图片附件。

![dsh-shot 加在 DSH 输入框里的相机按钮，位于「完全权限」标签右侧](docs/entry.png)

版式参照豆包/微信的截图工具：顶部「截图提问」胶囊、右上 ESC 与取消、白色虚线选区 + 8 个圆形手柄、尺寸浮标、选区下方「复制 / 取消 / 确认」，。框选层不是 DSH 窗口里的 DOM，而是宿主另开的分层窗口（每个显示器一个无边框置顶窗口），所以整屏含任务栏都会被压暗，DSH 主窗口不会被放大再缩回。

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
| 拖拽 | 画出自由选区，松手即锁定并可继续调整 |
| `R` `O` `A` `P` | 矩形 / 椭圆 / 箭头 / 画笔（也可直接点工具条上的按钮） |
| 鼠标停在窗口上 | **立刻自动框出整个窗口**，不用先点；移开就取消，拖动鼠标仍然是自由框选 |
| 单击 | 锁定当前框（鼠标悬停框出的那个，或刚拖出的那个），进入可调整状态 |
| 拖动框内 / 拖八个手柄 | 整体移动选区 / 改大小（可反复调整，`Esc` 退回自由框选） |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Enter`、双击选区内、点「确认」 | 裁剪并放进输入框 |
| `Esc`、右键、点「取消」 | 退出，不产出图片 |
| 右键相机按钮 | 切换「截屏时隐藏本窗口」（默认开，存 `localStorage`） |

「复制」把结果写进剪贴板（桌面端剪贴板权限被拒时会改为下载文件）。

## 两种框选引擎

| 引擎 | 何时使用 | 遮罩在哪 | 标注 |
| --- | --- | --- | --- |
| 分层窗口（默认） | Windows 桌面端，`overlay.ps1` 可用 | 宿主进程里的 WPF 置顶窗口，每屏一个 | 矩形 / 椭圆 / 箭头 / 画笔 + 撤销 / 取消 / 确认、悬停整窗选中、移动/八向缩放 |
| 页面内遮罩（兜底） | 宿主取不到覆盖层、或路由报错 | DSH 渲染进程里的 DOM 遮罩 | 矩形 / 椭圆 / 箭头 / 画笔 + 撤销重做 |

默认走分层窗口：点按钮后宿主先把冻结的全屏 PNG 抓到临时目录（按「隐藏本窗口」开关决定是否先最小化自己），紧接着 `overlay.ps1` 把冻结图铺到每个显示器上（**彩色冻结图 + 半透明黑色压暗**，暗区仍保留原色，和豆包一致但不做灰度化）——这一步不再中途还原窗口，所以不会出现「窗口冒两次」。框选后进入编辑态：选区保持原亮度、四外压暗，工具条浮在选区下方，可以画矩形/椭圆/箭头/画笔、撤销、取消或确认；鼠标停在某个窗口上就立刻框出整窗（不必先点），单击把它锁定成选区，随后可以整框拖动、拖八个手柄改大小；`Esc` 或**鼠标右键**先退回自由框选、再按一次才退出。尺寸浮标按豆包的写法显示 `宽 * 高`。点确认才用 GDI 从冻结图裁出物理像素 PNG 交给页面，覆盖层进程退出后宿主再把 DSH 窗口还原到原来的几何。页内遮罩仍然保留：宿主返回 204/非图片/抛错时自动回退，功能不会整个消失。

## 为什么需要 host 半

桌面端主进程在 `configureSession` 里把渲染进程的 `display-capture`、`clipboard-read` 等权限一律拒绝（`setPermissionRequestHandler` 回 false，`setDisplayMediaRequestHandler` 回空对象），所以页面里拿不到 `getDisplayMedia`，纯前端截屏这条路封死。

截屏因此交给操作系统：host 半用 PowerShell + GDI `CopyFromScreen` 抓整个虚拟桌面，PNG 在内存里编码后回传，不落任何临时文件。抓屏带上 `x-dsh-screen-width/height/origin-x/origin-y` 响应头，前端据此把选区换算回物理像素，裁剪时从原图取原生像素。

「隐藏本窗口」打开时，host 只做「最小化 → 抓屏」，**不会**中途还原或最大化；等覆盖层退出后才 `ShowWindow` 回来，并按存下的矩形摆位（原本最大化就回最大化）。还原脚本自身必须 `SetProcessDpiAwarenessContext(-4)`，否则 150% 缩放下 `SetWindowPos` 会把 2582×1550 放大成 1.5 倍；摆位后用 `GetWindowRect` 复核，最后再无条件 `SetWindowPos(HWND_NOTOPMOST, 0x0013)` 清掉置顶位。

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