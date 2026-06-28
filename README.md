# 🔧 Build Tool

基于 Node.js 的 Git 仓库构建工具，提供 Web 界面管理仓库、触发构建、下载产物。

## 快速开始

```bash
npm install
npm start        # 默认 http://localhost:3000
npm run dev      # 开发模式（文件变更自动重启）
```

浏览器打开 `http://localhost:3000`，使用默认账号登录。

## 默认账号

| 账号 | 密码 | 权限 |
|------|------|------|
| `admin` | `admin` | 完全管理权限 |
| `user` | `user` | 查看 + 构建 + 下载 |

自定义密码：

```bash
# Linux / Mac
ADMIN_PASS=xxx USER_PASS=yyy npm start

# Windows PowerShell
$env:ADMIN_PASS="xxx"; $env:USER_PASS="yyy"; npm start
```

## 功能

- **仓库管理** — 添加 / 编辑 / 删除 Git 仓库
- **分支选择** — 自动拉取远程分支列表
- **构建脚本** — 支持内联 Shell 脚本（多行 textarea）或上传脚本文件（.sh / .bat / .ps1）
- **并发控制** — 每仓库最多 3 个构建任务同时执行，超出排队等待
- **产物打包** — 构建完成后自动打包为 ZIP，可自定义打包目录（如 `dist`）
- **构建详情** — 每个任务独立页面：最近 5 个提交、终端日志、构建耗时
- **定时清理** — 每天凌晨 3 点自动清理过期产物和日志
- **认证** — Token 认证（30 天有效期），支持角色权限控制
- **日志系统** — 分级日志（DEBUG / INFO / WARN / ERROR），按日存档

## 项目结构

```
build-tool/
├── server.js              # 入口：Express 服务 + 认证
├── package.json
├── src/
│   ├── logger.js          # 日志模块（控制台 + 文件）
│   ├── db.js              # 数据存储（JSON 文件）
│   ├── git.js             # Git 操作（clone/fetch/branch/commits）
│   ├── builder.js         # 构建队列 + 执行 + ZIP 打包
│   ├── cleaner.js         # 定时清理
│   └── routes.js          # REST API 路由
├── public/
│   ├── index.html         # 主页
│   ├── detail.html        # 任务详情页
│   ├── login.html         # 登录页
│   ├── css/style.css
│   └── js/
│       ├── app.js         # 主页逻辑
│       └── detail.js      # 详情页逻辑
└── data/                  # 运行时数据（.gitignore 忽略）
    ├── db.json            # 仓库 + 任务数据
    ├── repos/             # 裸克隆的仓库
    ├── work/              # 构建工作目录（临时）
    ├── artifacts/         # 构建产物（ZIP）
    ├── logs/              # 服务日志 + 构建日志
    └── scripts/           # 上传的构建脚本
```

## API

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|:----:|
| POST | `/api/login` | 登录获取 token | - |
| POST | `/api/logout` | 撤销 token | - |
| GET | `/api/repos` | 仓库列表 | 全部 |
| POST | `/api/repos` | 添加仓库 | admin |
| PUT | `/api/repos/:id` | 更新仓库 | admin |
| DELETE | `/api/repos/:id` | 删除仓库 | admin |
| GET | `/api/repos/:id/branches` | 分支列表 | 全部 |
| POST | `/api/repos/:id/build` | 触发构建 | 全部 |
| POST | `/api/repos/:id/script` | 上传脚本文件 | admin |
| GET | `/api/repos/:id/script` | 读取脚本内容 | admin |
| POST | `/api/repos/:id/auth` | 设置 Git 凭证 | admin |
| DELETE | `/api/repos/:id/auth` | 清除 Git 凭证 | admin |
| GET | `/api/tasks` | 任务列表 | 全部 |
| GET | `/api/tasks/:id` | 任务详情 | 全部 |
| GET | `/api/tasks/:id/log` | 构建日志 | 全部 |
| GET | `/api/tasks/:id/download` | 下载产物 | 全部 |
| DELETE | `/api/tasks/:id` | 删除任务 | admin |
| POST | `/api/cleanup` | 手动清理 | admin |

## 构建脚本示例

**内联脚本（前端项目）：**

```bash
npm install
npm run build
```

**内联脚本（Go 项目）：**

```bash
go mod download
CGO_ENABLED=0 go build -o app .
```

**上传脚本文件：** 支持 `.sh`、`.bat`、`.ps1` 等任意格式。

## Git 认证

默认使用主机上已有的 Git 凭证（SSH Key / Git Credential Manager）。如果认证失败，仓库卡片会显示红色警告，点击"🔐 认证"可手动输入用户名和 Token。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `ADMIN_PASS` | admin 密码 | `admin` |
| `USER_PASS` | user 密码 | `user` |
| `LOG_LEVEL` | 日志级别 | `info` |

## 技术栈

- **后端**: Express.js + 原生 Node.js
- **前端**: 原生 HTML/CSS/JS（无框架）
- **存储**: JSON 文件
- **依赖**: archiver（ZIP）、multer（文件上传）、node-cron（定时任务）、uuid（ID 生成）
