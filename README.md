# 听谁 · PodCastByName

**当前版本：V0.5**

按“人”发现和追踪播客：找到一个人真正参与的对谈，而不仅是被节目提到的内容，并直接在产品内收听。

[在线体验](https://tingshui-podcast-by-name.choijun511.chatgpt.site) · [V0.5 更新日志](CHANGELOG.md)

## 功能

- 人物及中英文别名搜索、领域发现、出场依据和音频版本展示。
- 人物时间线与节目、语言、年份、收听状态筛选。
- 关注后新收录动态、稍后听队列、倍速、进度恢复和定时暂停。
- 补录需求与社区纠错投票；线上服务使用Cloudflare Worker和D1。

## 目录

- `site/`：已部署的线上源码，含前端、Worker接口、数据库schema与迁移。
- `prototype/`：本地Python/SQLite版本、既有RSS/审核原型与验收脚本。
- `PRODUCT.md`、`UX.md`、`DESIGN.md`：产品与设计说明。
- `CHANGELOG.md`：面向用户的更新日志；`RELEASE.md`：部署记录。
- `WEBSITE-STATUS.md`、`DEVELOPMENT-PLAN.md`：当前状态与后续计划。

## 本地运行

需要Python 3.9或更高版本，无额外Python运行依赖：

```sh
python3 prototype/dev.py start
```

打开 http://127.0.0.1:8765/ 。macOS也可双击「启动听谁.command」。停止服务使用 `python3 prototype/dev.py stop`。运行数据与管理令牌仅保存在本地，不纳入版本控制。

后端测试：

```sh
python3 -m unittest discover -s prototype -p 'test_*.py' -q
```

线上源码构建需要Node24和pnpm11.25.0：

```sh
cd site
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run validate
```

Cloudflare本地预览、迁移和发布说明见 [site/README.md](site/README.md)。浏览器验收脚本仍使用开发机的Playwright/Chrome绝对路径，其他环境需要先调整对应路径；它们不是开箱即用的CI。

## 当前边界

当前公开目录为3位人物、5个音频版本。入库流程暂缓；提交补录只保存需求，不代表自动查找或已确认收录。关注和收听状态仍按浏览器设备保存，没有账号同步。详见 [更新日志](CHANGELOG.md)。

`site/.openai/hosting.json` 标识现有Sites项目，不包含凭据。其他开发者部署自己的副本时，需要注册自己的项目和数据库，不应复用该项目身份。


### 入库后台（V0.5 后续开发）

已提供 `/admin.html` 入库影子控制台；流程、凭据说明、验证方法与未解锁项见 [INTAKE-WORKFLOW.md](INTAKE-WORKFLOW.md)。当前不会自动向公开目录发布候选，未接入云端定时器，也不调用付费 AI。

人物追踪更新：后台现在可以输入人物，一次搜索 Apple Podcasts 中美目录、自动登记节目并汇总证据；最多两个姓名、每个姓名每个地区50条，显示未覆盖渠道。新线索仍与已核验出场隔离，支持缓存、暂停恢复及页面重新登录续跑。
