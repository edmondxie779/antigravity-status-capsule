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
3. 打开 Antigravity 的 **Customizations -> Plugins** 页面，确认 `agy-capsule` 处于开启状态（若覆盖升级旧版，首次关闭再重新开启一次即可生效）。

### 后续更新

如果是通过 Git 克隆安装的，直接在插件目录拉取最新代码即可（`v1.1.0+` 会自动检测文件变化并在 5 秒内热重载）：

```bash
git -C ~/.gemini/config/plugins/agy-capsule pull
```

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
