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

## 前置要求：启用启动参数（必读）

底部状态胶囊通过本地 Chromium `DevToolsActivePort` 接口挂载到输入框栏，**启动 Antigravity 桌面端时需要带上 `--remote-debugging-port=0` 参数**：

### macOS

先完全退出客户端（`Cmd + Q`），然后在终端启动：

```bash
open -a Antigravity --args --remote-debugging-port=0
```

> **懒人技巧**：可以把别名写进 `~/.zshrc`，以后在终端输 `ag` 即可启动：
> ```bash
> echo "alias ag='open -a Antigravity --args --remote-debugging-port=0'" >> ~/.zshrc && source ~/.zshrc
> ```

### Windows

1. 右键桌面或开始菜单上的 **Antigravity 快捷方式** -> 点击 **属性**。
2. 在「**目标 (T)**」输入框的最末尾加一个**空格**和 `--remote-debugging-port=0`，例如：
   ```text
   "C:\Users\你的用户名\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=0
   ```
3. 点击 **确定** 保存，之后完全退出并双击该快捷方式启动即可。

### Linux

通过命令行 `antigravity --remote-debugging-port=0` 启动，或在桌面入口文件（`antigravity.desktop`）的 `Exec=` 行末尾添加 `--remote-debugging-port=0`。

---

## 安装方法

### 方式一：Git 一键安装（推荐）

**macOS / Linux：**

```bash
git clone https://github.com/edmondxie779/agy-capsule.git ~/.gemini/config/plugins/agy-capsule
```

**Windows（PowerShell）：**

```powershell
git clone https://github.com/edmondxie779/agy-capsule.git "$env:USERPROFILE\.gemini\config\plugins\agy-capsule"
```

（若本机已配置 `agy` CLI，也可克隆到任意目录后执行 `agy plugin install ./agy-capsule`。）

### 方式二：下载 Release 压缩包安装（无需 Git）

1. 前往 [Releases](https://github.com/edmondxie779/agy-capsule/releases) 下载最新的 `agy-capsule-v1.1.0.zip`。
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
- 客户端在线更新后自动重启时不会携带 `--remote-debugging-port=0` 参数（如果之前用过汉化/增强补丁，客户端更新也会重置 `.app` 包），导致本地没有生成 `DevToolsActivePort` 文件。
- **解决办法**：完全退出 Antigravity（macOS 按 `Cmd + Q` / Windows 退出托盘与窗口），再用上面带 `--remote-debugging-port=0` 的方式启动一次，后台插件会在 1 秒内自动把胶囊重新挂上去，无需重装或开关插件。

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
        └── deck_injector.mjs       # CDP 底部胶囊挂载与中文浮层渲染
```
