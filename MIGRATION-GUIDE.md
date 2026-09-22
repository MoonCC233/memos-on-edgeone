# 从 memos-on-cloudflare 迁移到 memos-on-edgeone

本指南帮助你将现有的 Cloudflare Workers + D1 + R2 部署迁移到 EdgeOne Makers + Turso + Blob/S3。

## 迁移概览

| 组件 | 迁移前 | 迁移后 | 迁移方式 |
|------|--------|--------|----------|
| 计算 | Cloudflare Workers | EdgeOne Pages Functions | 代码适配 (已完成) |
| 数据库 | Cloudflare D1 | Turso (libSQL) | SQL 导入 |
| 文件存储 | Cloudflare R2 | EdgeOne Blob / S3 | rclone 同步 |
| 实例设置 | D1 表 `system_setting` | Blob 存储 | 自动迁移脚本 |
| 用户设置 | D1 表 `user_setting` | Blob 存储 | 自动迁移脚本 |

## 步骤 1: 导出 Cloudflare D1 数据库

```bash
# 导出完整数据库 (结构 + 数据)
wrangler d1 export cfmemos-db --remote --output=backup.sql

# 或仅导出数据 (结构已在 migrations 中)
wrangler d1 export cfmemos-db --remote --output=data.sql --no-schema
```

## 步骤 2: 创建 Turso 数据库并导入

```bash
# 创建 Turso 数据库
turso db create memos-on-edgeone

# 获取连接信息
turso db show memos-on-edgeone --url
turso db tokens create memos-on-edgeone

# 导入数据
turso db shell memos-on-edgeone < backup.sql
```

## 步骤 3: 迁移 R2 文件到 EdgeOne Blob 或 S3

### 选项 A: 迁移到 EdgeOne Blob (推荐，默认)

```bash
# 安装 rclone
curl https://rclone.org/install.sh | sudo bash

# 配置 R2 源
rclone config create r2_source s3 \
  provider Cloudflare \
  env_auth false \
  access_key_id YOUR_R2_ACCESS_KEY \
  secret_access_key YOUR_R2_SECRET_KEY \
  endpoint https://<account-id>.r2.cloudflarestorage.com \
  region auto

# 注意: EdgeOne Blob 目前不直接支持 rclone
# 需要先下载到本地，再通过 EdgeOne CLI 或 API 上传
# 或者使用中转存储 (如临时 MinIO)
```

### 选项 B: 迁移到 S3 兼容存储 (MinIO, AWS S3, R2, OSS 等)

```bash
# 配置目标 S3
rclone config create s3_target s3 \
  provider Other \
  env_auth false \
  access_key_id YOUR_S3_ACCESS_KEY \
  secret_access_key YOUR_S3_SECRET_KEY \
  endpoint https://s3.your-provider.com \
  region your-region \
  bucket your-bucket

# 同步文件 (保持目录结构)
rclone sync r2_source:cfmemos/attachments s3_target:memos/attachments --progress
rclone sync r2_source:cfmemos/avatars s3_target:memos/avatars --progress
```

## 步骤 4: 更新附件表引用

迁移文件后，需要更新数据库中 `attachment` 表的 `reference` 字段：

```sql
-- 如果迁移到 S3，reference 已经是完整 key，可能只需更新 storage_type
UPDATE attachment SET storage_type = 'BLOB' WHERE storage_type = 'R2';

-- 如果文件路径变了，批量更新
-- 例如: R2 key 为 "attachments/abc123/image.png"
-- S3 key 为 "memos/attachments/abc123/image.png"
UPDATE attachment 
SET reference = REPLACE(reference, 'attachments/', 'memos/attachments/'),
    storage_type = 'BLOB'
WHERE storage_type = 'R2';
```

## 步骤 5: 迁移实例设置和用户设置到 Blob

新版本提供了迁移脚本，将 D1 中的设置导入 Blob：

```bash
# 设置环境变量
export TURSO_DATABASE_URL="libsql://your-db.turso.io"
export TURSO_AUTH_TOKEN="your-token"
export BLOB_STORE_NAME="memos"

# 运行迁移脚本 (需创建)
node scripts/migrate-settings.js
```

迁移脚本示例 (`scripts/migrate-settings.js`)：

```javascript
import { createClient } from '@libsql/client';
import { createStorageProvider } from '../worker/src/storage';
import { BlobSettingsStore } from '../worker/src/db/settings-blob';

async function migrateSettings() {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const storage = await createStorageProvider({ BLOB_STORE_NAME: process.env.BLOB_STORE_NAME });
  const settingsStore = new BlobSettingsStore(storage);

  // 1. 迁移系统设置
  const systemSettings = await db.execute('SELECT * FROM system_setting');
  const sysSettings = systemSettings.rows.map(row => ({
    name: row.name,
    value: row.value,
    description: row.description
  }));
  await storage.put('settings/instance.json', JSON.stringify({ settings: sysSettings }), { contentType: 'application/json' });
  console.log(`Migrated ${sysSettings.length} system settings`);

  // 2. 迁移用户设置
  const userSettings = await db.execute('SELECT * FROM user_setting');
  const byUser = new Map();
  for (const row of userSettings.rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push({ user_id: row.user_id, key: row.key, value: row.value });
  }

  for (const [userId, settings] of byUser.entries()) {
    await storage.put(`settings/users/${userId}.json`, JSON.stringify({ settings }), { contentType: 'application/json' });
  }
  console.log(`Migrated settings for ${byUser.size} users`);

  await db.close();
}

migrateSettings().catch(console.error);
```

## 步骤 6: 配置 EdgeOne 环境变量

在 EdgeOne 控制台设置以下环境变量：

```
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token
JWT_SECRET=your-existing-jwt-secret
INSTANCE_NAME=your-instance-name
APP_VERSION=1.0.0
BLOB_STORE_NAME=memos

# 如果使用 S3 存储
# STORAGE_TYPE=s3
# S3_ENDPOINT=https://s3.your-provider.com
# S3_REGION=your-region
# S3_BUCKET=your-bucket
# S3_ACCESS_KEY_ID=your-key
# S3_SECRET_ACCESS_KEY=your-secret
```

## 步骤 7: 部署并验证

```bash
# 部署
edgeone deploy

# 验证
# 1. 访问部署域名
# 2. 登录现有账号
# 3. 检查附件是否正常显示
# 4. 检查设置是否生效
```

## 常见问题

**Q: 迁移后附件无法访问？**  
A: 检查 `attachment` 表的 `reference` 字段是否指向正确的存储路径，`storage_type` 是否为 `'BLOB'`。

**Q: 设置丢失？**  
A: 运行迁移脚本将 D1 设置导入 Blob，或在管理面板重新配置。

**Q: 数据库查询报错？**  
A: Turso 基于 libSQL，与 SQLite 兼容性极高。检查是否使用了 D1 特有的 PRAGMA 语句，需移除。

**Q: 如何回滚？**  
A: 保持 Cloudflare Workers 部署不变，仅切换 DNS 到 EdgeOne。如有问题，切回 Cloudflare。

## 验证清单

- [ ] 数据库数据完整 (用户、备忘录、标签、评论等)
- [ ] 附件文件可正常上传/下载/预览
- [ ] 实例设置 (站点名称、公开设置等) 生效
- [ ] 用户设置 (主题、语言、编辑器偏好等) 生效
- [ ] 个人访问令牌 (PAT) 正常工作
- [ ] Webhook 通知正常发送
- [ ] SSO 登录正常
- [ ] RSS 订阅正常
- [ ] 多语言切换正常