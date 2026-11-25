---
name: bloom-web-ui
description: 在真实 DSH Web 中验收 Bloom 的候选包、设置页、主题切换和发布媒体。使用独立 profile，适用于日常 UI 验证和发版前验收。
---

# Bloom Web 验收

在独立 worktree 构建并打包。用临时 `DSH_HOME`，通过 `dsh plugin --profile web add` 安装候选 tarball，核对已安装 manifest 的版本。启动 `dsh --profile web --no-open --port <空闲端口>`，浏览器使用启动时给出的本地链接。认证链接只传给测试浏览器。整个过程无需安装桌面应用或改动日常 profile。

先在空工作区打开「设置 → Bloom」，检查导航图标、配色选择、材质和输入框透明开关的状态，以及「关于 Bloom」的运行版本。用真实控件检查浅色、深色和跟随系统，再进入会话验证输入框和原生顶栏控件。涉及设置布局时，在宽、窄视口验证滚动和键盘操作。

发布素材使用隔离工作区和示例内容。每次截图或录制前运行 `scripts/redact-for-shot.js`，复核画面中没有真实项目、路径、账号或凭据。记录宿主版本、插件版本、产物哈希和真实操作结果。上传后核对双语 README 使用同一版本的截图和视频，再按贡献指南核对 CI 与 npm。
