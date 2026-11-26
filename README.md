# agy-capsule

为 Google Antigravity 输入框底部栏注入实时状态胶囊（**上下文占用 / 模型配额 / 吞吐率与全会话统计**），直接读取本地会话 SQLite 数据库的真实 API 计费元数据。

## 功能特性

- **真实 API 遥测数据**：直接从本地会话库（macOS/Linux: `~/.gemini/antigravity/conversations/<id>.db`，Windows: `%USERPROFILE%\.gemini\antigravity\conversations\<id>.db`）解析 `uncached_input`、`cached_input`、`thinking_tokens`、`output_tokens` 及模型上下文上限。
- **三个底部胶囊与中文悬停面板**：
  1. **上下文胶囊（`XX%`）**：展示当前活跃上下文窗口使用率（`>=75%` 琥珀色、`>=90%` 红色预警），悬停查看缓存命中率与 3m/4m 过期提醒、`首轮 / 读取 / 思考 / 输出` 占比（自动识别 `/compact` 压缩检查点），以及底部累计消耗摘要。
  2. **模型配额胶囊（`5h% · 每周%`）**：自动匹配当前选中的模型分组（Gemini / Argon / Carbon / Claude / GPT 等），低配额（`<=25%` / `<=10%`）自动变色提醒，悬停查看全部模型组的剩余额度环与重置倒计时。
  3. **会话统计与吞吐胶囊（`XX.X tok/s`）**：悬停查看**对话持续时长**（总跨度 + 扣除人工等待的 **AI 实际耗时**，运行中实时读秒）、**全会话累计 Token 四维明细**（`缓存命中 / 新增输入 / 思考生成 / 回复输出`）、平均生成速度与请求轮次统计。
- **9 级窄窗口自适应折叠**：侧边栏或输入框变窄时依次折叠次要指标，避免遮挡模型选择器。
- **极低后台开销与自动热更新**：基于 `.db` / `.db-wal` 文件指纹缓存解析结果，渲染进程单次挂载增量更新，源码更新后自动热重启 Sidecar。

---

## 启动方式：通常无需任何启动参数

插件会在后台自动连接 Antigravity 主进程，**正常双击启动即可**，客户端自动更新重启后也会自动重新挂载：

1. Sidecar 找到 Antigravity 主进程，并先读取应用二进制里的 Electron fuse，确认这个版本支持临时开启主进程调试接口（不支持时绝不发送信号）。
2. 临时开启主进程的 Node inspector，在主进程内安装一个仅监听 `127.0.0.1`、带随机 token 的极简桥接服务（凭据文件权限 `0600`），然后**立即关闭 inspector**，整个过程不到一秒。
3. 之后胶囊的渲染都通过这个桥接完成；Sidecar 热重启会直接复用桥接，App 退出时桥接随之消失。

可以用下面的命令自检当前版本是否支持免参数模式（只读检测，不会对 App 做任何操作）：

```bash
node ~/.gemini/config/plugins/agy-capsule/sidecars/agy_capsule/bridge.mjs --diagnose
```

### 备用方案：带 `--remote-debugging-port=0` 启动

如果自检显示 fuse 为 `disabled`（某些版本可能在打包时关闭了该能力），插件会自动回退到 Chromium `DevToolsActivePort` 方式，此时需要在启动 Antigravity 时带上 `--remote-debugging-port=0` 参数（带了参数时插件也会优先使用这种方式）：

#### macOS

先完全退出客户端（`Cmd + Q`），然后在终端启动：

```bash
open -a Antigravity --args --remote-debugging-port=0
```

> **懒人技巧**：可以把别名写进 `~/.zshrc`，以后在终端输 `ag` 即可启动：
> ```bash
> echo "alias ag='open -a Antigravity --args --remote-debugging-port=0'" >> ~/.zshrc && source ~/.zshrc
> ```

#### Windows

1. 右键桌面或开始菜单上的 **Antigravity 快捷方式** -> 点击 **属性**。
2. 在「**目标 (T)**」输入框的最末尾加一个**空格**和 `--remote-debugging-port=0`，例如：
   ```text
   "C:\Users\你的用户名\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=0
   ```
3. 点击 **确定** 保存，之后完全退出并双击该快捷方式启动即可。

#### Linux

通过命令行 `antigravity --remote-debugging-port=0` 启动，或在桌面入口文件（`antigravity.desktop`）的 `Exec=` 行末尾添加 `--remote-debugging-port=0`。

---

## 安装方法

### 方式一：Git 一键安装（推荐）

**macOS / Linux：**

```bash
git clone https://github.com/edmondxie779/antigravity-status-capsule.git ~/.gemini/config/plugins/agy-capsule
```

**Windows（PowerShell）：**

```powershell
git clone https://github.com/edmondxie779/antigravity-status-capsule.git "$env:USERPROFILE\.gemini\config\plugins\agy-capsule"
```

（若本机已配置 `agy` CLI，也可克隆到任意目录后执行 `agy plugin install ./agy-capsule`。）

### 方式二：下载 Release 压缩包安装（无需 Git）

1. 前往 [Releases](https://github.com/edmondxie779/antigravity-status-capsule/releases) 下载最新的 `agy-capsule-v1.1.0.zip`。
2. 将压缩包内的 `agy-capsule` 文件夹解压放入插件目录（最终路径如下）：
   - **macOS / Linux**：`~/.gemini/config/plugins/agy-capsule/plugin.json`
   - **Windows**：`%USERPROFILE%\.gemini\config\plugins\agy-capsule\plugin.json`
3. 打开 Antigravity 的 **Customizations -> Plugins** 页面，确认 `agy-capsule` 处于开启状态。

### 后续更新

如果是通过 Git 克隆安装的，直接在插件目录拉取最新代码即可（`v1.1.0+` 会自动检测文件变化并在 5 秒内热重载）：

```bash
git -C ~/.gemini/config/plugins/agy-capsule pull
```

---

## 常见问题（FAQ）

**Q：刚装好或者 Antigravity 自动更新版本后，底部胶囊不见了？**
- 先运行上面的 `--diagnose` 自检命令：
  - 显示 `enabled`：通常几秒内会自动挂上；如果没有，在 Customizations -> Plugins 里关闭再开启一次插件。
  - 显示 `disabled`：当前版本不支持免参数模式，请按「备用方案」带 `--remote-debugging-port=0` 启动（客户端在线更新后自动重启时不会携带该参数，需要完全退出后重新用带参数的方式启动一次）。
- 如果自检找不到主进程（例如使用了改名的客户端），可以用环境变量 `AGY_CAPSULE_MAIN_PID=<pid>` 指定。

---

## 目录结构

```text
agy-capsule/
├── plugin.json                     # 插件清单
├── logo.svg                        # 插件图标
├── README.md                       # 说明与安装文档
└── sidecars/
    └── agy_capsule/
        ├── sidecar.json            # 常驻 Sidecar 配置
        ├── server.mjs              # SQLite 遥测解析、缓存与配额聚合
        ├── deck_injector.mjs       # 底部胶囊挂载与中文浮层渲染（CDP / 桥接两种通道）
        └── bridge.mjs              # 免启动参数的主进程桥接（含 --diagnose 自检）
```
