# Memos on EdgeOne Makers

将 [Memos](https://github.com/usememos/memos) 笔记应用迁移到 **EdgeOne Makers** 全栈部署平台，**所有数据（包括配置、用户、备忘录等）全部存储在 EdgeOne Blob**，也可选配置 **S3 兼容存储**。零外部依赖，纯 Blob 存储架构。

## ✨ 核心特性

- 🚀 **完全托管** - 无需维护服务器，EdgeOne Makers 一条龙部署
- 🔗 **GitHub 直接部署** - 控制台关联仓库，推送即部署，无需 CLI
- 💾 **纯 Blob 存储架构** - 所有数据（用户、备忘录、配置、附件）全部存储在 EdgeOne Blob，无需外部数据库
- ☁️ **可选 S3 兼容存储** - 支持 MinIO、AWS S3、Cloudflare R2、阿里云 OSS、腾讯云 COS 等
- 🔧 **零外部依赖** - 不需要 Turso、D1 或任何外部数据库
- 📦 **默认 EdgeOne Blob** - 开箱即用的分布式对象存储，无需额外配置
- ⚙️ **所有配置存储在 Blob** - 实例设置、用户设置全部存储在 Blob 中
- 🔄 **零运维** - 存储、计算全托管

## 🛠 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | EdgeOne Pages Functions (Node.js) |
| 后端框架 | Hono |
| 数据存储 | **EdgeOne Blob** (默认) / S3 兼容存储 (可选) - **所有数据** |
| AI 转写 | 可配置外部 API (OpenAI Whisper 等) |
| 前端 | React + Vite + TailwindCSS |
| 认证 | JWT (HS256) + bcrypt |

## 🚀 快速部署 (推荐：GitHub 直接部署)

### 方式一：EdgeOne 控制台关联 GitHub (无需 CLI)

1. **Fork 本仓库** 到你的 GitHub 账号

2. **在 EdgeOne 控制台创建项目**
   - 登录 [EdgeOne 控制台](https://console.edgeone.ai/)
   - 进入 **边缘应用** → **Pages** → **创建项目**
   - 选择 **从 Git 仓库导入**
   - 授权 GitHub，选择 Fork 的仓库
   - 构建配置自动读取 `edgeone.json`

3. **配置环境变量** (项目设置 → 环境变量)
   ```
   JWT_SECRET=your-super-secret-jwt-key (生成: openssl rand -base64 32)
   INSTANCE_NAME=memos-on-edgeone
   APP_VERSION=1.0.0
   BLOB_STORE_NAME=memos
   ```

4. **访问你的 Memos** - 部署成功后分配的域名即可访问，首次访问进入管理员注册页面

**无需任何数据库初始化 - Blob 会自动创建！**

---

### 方式二：本地开发 + 推送自动部署

```bash
# 1. 克隆并安装依赖
git clone https://github.com/MoonCC233/memos-on-edgeone.git
cd memos-on-edgeone
npm install && cd web && npm install && cd ..

# 2. 配置本地环境变量
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入 JWT_SECRET 等

# 3. 本地开发 (两个终端)
npm run dev          # 终端1: EdgeOne Functions 后端
npm run dev:web      # 终端2: 前端开发服务器

# 4. 推送到 GitHub 触发自动部署
git push origin main
```

## ⚙️ 配置 S3 兼容存储 (可选)

默认使用 **EdgeOne Blob**。如需使用 S3 兼容存储，在环境变量中设置：

```bash
STORAGE_TYPE=s3
S3_ENDPOINT=https://s3.your-provider.com
S3_REGION=auto
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_FORCE_PATH_STYLE=true  # MinIO 等需要
```

支持服务：MinIO、AWS S3、Cloudflare R2、阿里云 OSS、腾讯云 COS、七牛云 Kodo、又拍云 USS、华为云 OBS 等。

## 📁 项目结构

```
├── edgeone.json              # EdgeOne Pages 配置 (自动读取)
├── package.json              # 根 package，构建脚本
├── .dev.vars.example         # 本地开发环境变量模板
├── worker/
│   └── src/
│       ├── index.ts          # Hono 入口，EdgeOne Functions 处理器
│       ├── types.ts          # EdgeOne 环境类型定义
│       ├── storage/          # 存储抽象层
│       │   └── index.ts      # Blob/S3 统一接口
│       ├── db/               # 数据库层 (纯 Blob)
│       │   ├── blob-database.ts # Blob 数据库引擎 (所有数据)
│       │   ├── settings-blob.ts # 设置存储
│       │   └── *.ts          # 各业务表查询
│       ├── routes/           # API 路由
│       ├── auth/             # JWT、密码哈希、PAT
│       └── middleware/       # 认证、提供者初始化
└── web/                      # 前端 (React + Vite)
```

## 🔐 环境变量说明

| 变量 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `JWT_SECRET` | JWT 签名密钥 | 是 | - |
| `BLOB_STORE_NAME` | EdgeOne Blob 存储库名 | 否 | `memos` |
| `STORAGE_TYPE` | 存储类型: `blob` \| `s3` | 否 | `blob` |
| `S3_ENDPOINT` | S3 端点 | S3模式必填 | - |
| `S3_REGION` | S3 区域 | 否 | `auto` |
| `S3_BUCKET` | S3 桶名 | S3模式必填 | - |
| `S3_ACCESS_KEY_ID` | S3 Access Key | S3模式必填 | - |
| `S3_SECRET_ACCESS_KEY` | S3 Secret Key | S3模式必填 | - |
| `S3_FORCE_PATH_STYLE` | 强制路径风格 | 否 | `true` |
| `INSTANCE_NAME` | 实例名称 | 否 | `memos-on-edgeone` |
| `APP_VERSION` | 应用版本 | 否 | `1.0.0` |

## 🔄 自动部署流程

```
推送代码到 GitHub main 分支
        ↓
EdgeOne 检测到推送
        ↓
自动执行安装命令: npm install && cd web && npm install
        ↓
自动执行构建命令: npm run build:web
        ↓
部署前端到 EdgeOne Pages CDN
        ↓
部署 Functions 到 EdgeOne 边缘节点
        ↓
分配/更新域名，部署完成
```

## 🆚 与原版 Memos / Cloudflare 版本对比

| 项目 | 原版 Memos | memos-on-cloudflare | **memos-on-edgeone** |
|------|-----------|---------------------|---------------------|
| 后端 | Go + gRPC | Cloudflare Workers + Hono | **EdgeOne Pages Functions + Hono** |
| 数据库 | SQLite (本地文件) | Cloudflare D1 | **纯 Blob 存储 (JSON 文档)** |
| 文件存储 | 本地/S3 | **Cloudflare R2 (强制)** | **EdgeOne Blob (默认) / S3 可选** |
| 配置存储 | 数据库表 | 数据库表 | **Blob 存储** |
| 用户/备忘录 | 数据库表 | 数据库表 | **Blob 存储** |
| AI | OpenAI/Gemini | Cloudflare Workers AI | **可配置外部 API** |
| 部署 | Docker/二进制 | `wrangler deploy` | **Git 推送自动部署** |
| 运维 | 需要服务器 | 无服务器 | **完全托管，零外部依赖** |
| 数据库初始化 | SQLite 迁移 | D1 迁移 | **无需初始化，Blob 自动创建** |

## ❓ 常见问题

**Q: 为什么不用外部数据库？**  
A: 纯 Blob 存储架构更简单，零外部依赖，EdgeOne Makers 内置 1GB 免费存储，完全够用。所有数据都是 JSON 文档，易于备份和迁移。

**Q: EdgeOne Blob 有什么限制？**  
A: 单个值最大 25MB，免费版提供 1GB 账户存储容量。对个人/中小项目完全足够。大文件建议配置 S3 兼容存储。

**Q: 数据量大了怎么办？**  
A: 如果数据量超过 Blob 免费额度，可配置 S3 兼容存储（MinIO 自建、AWS S3 等），设置 `STORAGE_TYPE=s3` 即可切换。

**Q: 如何从 memos-on-cloudflare 迁移？**  
参考 [MIGRATION-GUIDE.md](./MIGRATION-GUIDE.md)

**Q: 推送代码后多久部署完成？**  
通常 2-5 分钟，取决于构建时间。可在控制台查看部署日志。

## 📜 License

MIT