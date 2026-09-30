# 听谁 · 线上版本

此目录是独立Sites源码，保留现有静态界面，后端适配Cloudflare Worker + D1。平台身份在 `.openai/hosting.json`；生产部署由Sites工具执行，不使用本地wrangler配置部署。

## 当前能力与边界

- 公开搜索、人物筛选、真实RSS音源、关注动态、设备本地收听进度/队列/定时。
- D1持久化补录请求、纠错票与隐藏关系；设备凭据只存哈希；POST来源、输入大小、设备及网络频率限制。
- 首次请求将 `worker/catalog.json` 的已审核公开快照写入D1，之后不会覆盖已存在的审核/隐藏状态；迁移仅建表。当前3人5音频版本。
- 线上不提供RSS抓取、模型调用或管理端，入库按用户要求暂缓。已有本地Python后台保留在上级prototype，不打包上传。
- 补录请求只保存需求，状态仍为排队，不假装已经查找；本地设备记录不自动跨到新域名，暂没有账号同步。
- 设备票不等于独立用户，限频不能杜绝刷票；3票反对且至少2/3触发隐藏，保留记录。恢复需后续受限管理流程，当前不对公众暴露管理写接口。

## 开发与验证

运行环境Node24；包管理器pnpm11.25.0，版本与lockfile已锁定。`pnpm install --frozen-lockfile`，`pnpm run build`，`pnpm test`，`pnpm run validate`。

`db/schema.ts` 是表结构源；`pnpm db:generate`生成Drizzle迁移。已发布迁移不可重写；后续schema变更追加迁移。D1访问统一通过worker里的dbFor/rows/first；多步写入使用batch事务。

本地Worker验收：
```
pnpm exec wrangler d1 execute tingshui-local --local --file drizzle/0000_smart_whizzer.sql
pnpm exec wrangler dev --local --port 18767 --inspector-port 0
```
`wrangler.json`只用于本地隔离数据库；不包含生产数据库ID。`test/browser.cjs`固定访问18767，补录写入仅发生在本地模拟器。该脚本沿用当前机器的Playwright/Chrome路径。

## 发布与回退

用Sites提供的site-workflow脚本同步精确源码、运行检查并打包，再save_site_version/deploy_site_version。部署后以平台succeeded结果为准。公开访问由用户明确授权。发布包只有6个公开前端文件、Worker和schema迁移，没有SQLite本地文件、令牌、日志、未审核候选或私人请求。

回退代码：部署此前已保存且与当前schema兼容的版本。D1迁移可能早于Worker发布完成，因此失败部署也不可假定数据库未变化；不自动删除云数据。

后续扩大目录时需做显式、可审计的增量发布工具；不要删除catalog-v1标志或把初始化当作全量覆盖机制。
