# Memos on EdgeOne Makers

将 [Memos](https://github.com/usememos/memos) 笔记应用迁移到 **EdgeOne Makers** 全栈部署平台，使用 **EdgeOne Blob** 作为默认文件存储，**Turso (libSQL)** 作为数据库，可选配置 **S3 兼容存储**。

## 核心特性

✅ **完全托管** - 无需维护服务器，EdgeOne Makers 一条龙部署  
✅ **GitHub 直接部署** - 控制台关联仓库，推送即部署，无需 CLI  
✅ **默认使用 EdgeOne Blob** - 开箱即用的分布式对象存储，无需额外配置  
✅ **可选 S3 兼容存储** - 支持 MinIO、AWS S3、Cloudflare R2、阿里云 OSS、腾讯云 COS 等  
✅ **所有配置存储在 Blob** - 实例设置、用户设置全部存储在 Blob 中，无需额外数据库表  
✅ **SQLite 兼容数据库** - 使用 Turso (libSQL)，原有 SQL 查询几乎无需修改  
✅ **零运维** - 数据库、存储、计算全托管

## 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | EdgeOne Pages Functions (Node.js) |
| 后端框架 | Hono |
| 数据库 | Turso (libSQL) - SQLite 兼容，HTTP 访问 |
| 文件存储 | **EdgeOne Blob** (默认) / S3 兼容存储 (可选) |
| AI 转写 | 可配置外部 API (OpenAI Whisper 等) |
| 前端 | React + Vite + TailwindCSS |
| 认证 | JWT (HS256) + bcrypt |
| 缓存 | EdgeOne KV (可选) |

## 快速部署 (推荐：GitHub 直接部署)

### 方式一：EdgeOne 控制台关联 GitHub (推荐，无需 CLI)

1. **Fork 本仓库** 到你的 GitHub 账号

2. **创建 Turso 数据库**
   ```bash
   # 安装 Turso CLI
   curl -sSfL https://get.tur.so/install.sh | bash
   
   # 创建数据库
   turso db create memos-on-edgeone
   
   # 获取连接信息
   turso db show memos-on-edgeone --url
   turso db tokens create memos-on-edgeone
   ```

3. **在 EdgeOne 控制台创建项目**
   - 登录 [EdgeOne 控制台](https://console.edgeone.ai/)
   - 进入 **边缘应用** → **Pages** → **创建项目**
   - 选择 **从 Git 仓库导入**
   - 授权 GitHub，选择你 Fork 的仓库
   - 配置构建设置 (会自动读取 `edgeone.json`)：
     - **构建命令**: `npm run build:web`
     - **安装命令**: `npm install && cd web && npm install`
     - **输出目录**: `./web/dist`
     - **Node.js 版本**: 22.11.0

4. **配置环境变量** (在项目设置 → 环境变量中添加)
   ```
   TURSO_DATABASE_URL=libsql://your-db.turso.io
   TURSO_AUTH_TOKEN=your-auth-token
   JWT_SECRET=your-super-secret-jwt-key-here (生成: openssl rand -base64 32)
   INSTANCE_NAME=memos-on-edgeone
   APP_VERSION=1.0.0
   BLOB_STORE_NAME=memos
   ```

5. **首次部署后初始化数据库**
   - 部署完成后，在控制台项目的 **Functions** 标签页
   - 打开 **终端** 或使用本地终端：
   ```bash
   # 本地安装依赖后运行迁移 (需配置 .dev.vars)
   npm run db:migrate:remote
   ```
   或在 EdgeOne 控制台的 Functions 终端中运行：
   ```bash
   node scripts/migrate.js --remote
   ```

6. **访问你的 Memos**
   - 部署成功后，EdgeOne 分配的域名即可访问
   - 首次访问进入管理员注册页面

---

### 方式二：本地开发 + 手动部署

```bash
# 1. 克隆并安装依赖
git clone https://github.com/your-username/memos-on-edgeone.git
cd memos-on-edgeone
npm install && cd web && npm install && cd ..

# 2. 配置本地环境变量
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入 Turso URL、Token、JWT_SECRET 等

# 3. 初始化数据库
npm run db:migrate

# 4. 本地开发 (两个终端)
npm run dev          # 终端1: EdgeOne Functions 后端
npm run dev:web      # 终端2: 前端开发服务器

# 5. 推送到 GitHub 触发自动部署
git push origin main
```

## 配置 S3 兼容存储 (可选)

默认使用 **EdgeOne Blob** 存储。如需使用 S3 兼容存储，在 EdgeOne 控制台环境变量中设置：

```bash
STORAGE_TYPE=s3
S3_ENDPOINT=https://s3.your-provider.com
S3_REGION=auto
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_FORCE_PATH_STYLE=true  # MinIO 等需要
```

支持的 S3 兼容服务：
- **MinIO** (自建)
- **AWS S3**
- **Cloudflare R2**
- **阿里云 OSS**
- **腾讯云 COS**
- **七牛云 Kodo**
- **又拍云 USS**
- **华为云 OBS**

## 项目结构

```
├── edgeone.json              # EdgeOne Pages 配置 (自动读取)
├── package.json              # 根 package，构建脚本
├── .dev.vars.example         # 本地开发环境变量模板
├── migrations/               # 数据库迁移文件 (SQLite 兼容)
├── scripts/
│   ├── migrate.js            # Turso 迁移脚本
│   └── migrate-settings.js   # 设置迁移脚本
├── worker/
│   └── src/
│       ├── index.ts          # Hono 入口，EdgeOne Functions 处理器
│       ├── types.ts          # EdgeOne 环境类型定义
│       ├── storage/          # 存储抽象层
│       │   └── index.ts      # Blob/S3 统一接口
│       ├── db/               # 数据库层
│       │   ├── index.ts      # Turso 数据库提供者 + Schema
│       │   ├── d1-wrapper.ts # D1Database 兼容包装器
│       │   ├── settings-blob.ts # Blob 存储设置
│       │   └── *.ts          # 各业务表查询
│       ├── routes/           # API 路由
│       ├── auth/             # JWT、密码哈希、PAT
│       └── middleware/       # 认证、提供者初始化
└── web/                      # 前端 (React + Vite)
```

## 环境变量说明

| 变量 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `TURSO_DATABASE_URL` | Turso 数据库 URL | 是 | - |
| `TURSO_AUTH_TOKEN` | Turso 认证 Token | 是 | - |
| `BLOB_STORE_NAME` | EdgeOne Blob 存储库名 | 否 | `memos` |
| `STORAGE_TYPE` | 存储类型: `blob` \| `s3` | 否 | `blob` |
| `S3_ENDPOINT` | S3 端点 | S3模式必填 | - |
| `S3_REGION` | S3 区域 | 否 | `auto` |
| `S3_BUCKET` | S3 桶名 | S3模式必填 | - |
| `S3_ACCESS_KEY_ID` | S3 Access Key | S3模式必填 | - |
| `S3_SECRET_ACCESS_KEY` | S3 Secret Key | S3模式必填 | - |
| `S3_FORCE_PATH_STYLE` | 强制路径风格 | 否 | `true` |
| `JWT_SECRET` | JWT 签名密钥 | 是 | - |
| `INSTANCE_NAME` | 实例名称 | 否 | `memos-on-edgeone` |
| `APP_VERSION` | 应用版本 | 否 | `1.0.0` |

## 自动部署流程

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

## 常见问题

**Q: 为什么选择 Turso 而不是 Cloudflare D1？**  
A: EdgeOne Pages Functions 无法直接绑定 Cloudflare D1。Turso 提供 HTTP API，可在任何边缘运行时访问，且 SQLite 兼容，迁移成本极低。

**Q: EdgeOne Blob 有什么限制？**  
A: 目前免费额度充足，适合个人/中小项目。大文件建议配置 S3 兼容存储。

**Q: 如何从 memos-on-cloudflare 迁移？**  
参考 [MIGRATION-GUIDE.md](./MIGRATION-GUIDE.md)

**Q: 本地开发如何使用真实数据库？**  
在 `.dev.vars` 中设置 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN` 指向生产/测试数据库。

**Q: 推送代码后多久部署完成？**  
通常 2-5 分钟，取决于构建时间。可在控制台查看部署日志。

**Q: 如何查看部署日志？**  
EdgeOne 控制台 → 项目 → 部署记录 → 点击查看详细日志

## 许可证

MIT