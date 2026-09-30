# 听谁 · 公开上线记录

日期：2026-09-29。URL：https://tingshui-podcast-by-name.choijun511.chatgpt.site

用户明确授权任何拿到链接的人访问；Sites audience 为 public。部署返回 succeeded，env revision 0。

- project_id: appgprj_6abb952f396081919e27c272155b09be
- version_id: appgprj_6abb952f396081919e27c272155b09be~appgver_6ba1a4189e908191b6ac9d71ab641567（版本1）
- deployment_id: appgdep_6abb96d70de88191885e7005146d6d2d
- source commit: 9f7028a9f565ea03e76d3f327486559fdcafc8ae
- source checkout: site/

线上保留搜索、领域发现、人物时间线筛选、真实音频、关注动态、队列与定时；补录请求、投票及隐藏关系由D1持久化。关注与收听记录仍按此前约定设备本地保存，localhost与线上域名存储互不共享。当前3位人物、5个音频版本。

验收：4组Worker/SQLite API测试全部通过；Cloudflare本地D1执行12条schema语句成功；本地Worker浏览器测试通过真实中英文播放、搜索、关注、续听、请求持久化与设备隔离、移动布局及管理页面不可访问。额外在本地D1验证3设备负票事务、达到门槛后撤回。生产URL未另外做浏览器检查，发布成功由Sites原生部署结果确认；已在Codex打开线上链接供试用。

安全和范围：没有上传本地SQLite/凭据/私人补录记录/未审核候选；HTTP API校验来源、JSON大小、参数、设备凭据哈希，并限制写频。所有音源直连发布者，无开放代理。线上管理与模型请求关闭。设备票仍不能证明独立真人，当前社区隐藏规则不宣称抗刷票。

入库继续PENDING。最终提醒保留：模型服务配置、真实跨领域准确率/成本评测与RSS规则模板验证；当前上线不是入库质量已验证。

回退：通过Sites重新部署已保存且schema兼容的版本。首个版本当前无前一版本可回退；需要暂停访问时修改站点访问范围而非删除云数据。D1 schema迁移独立持久化，不因代码回退自动逆转。
