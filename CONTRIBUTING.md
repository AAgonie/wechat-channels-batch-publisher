# 参与贡献

欢迎提交 Issue 或 Pull Request。

## 提交问题

请优先使用仓库的问题模板，并确保所有截图、日志和 DOM 片段已经脱敏。不要提交 Cookie、会话 ID、手机号、账号名称、未公开视频、真实剧名或其他业务数据。

## 修改代码

1. Fork 仓库并创建独立分支。
2. 保持 Manifest V3 兼容。
3. 不增加与发布流程无关的权限、网络请求或数据收集。
4. 同步考虑 Chrome 与 Edge 的等待差异。
5. 执行：

```powershell
node --check ./content.js
node --check ./background.js
./scripts/build.ps1
```

6. 在 Pull Request 中说明测试浏览器、版本、步骤与结果。

页面定位修改必须提供实际 DOM 依据，不能仅凭截图猜测选择器。
