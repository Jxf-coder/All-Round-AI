# All-Round-AI

面向 Windows 10、Windows 11 和 macOS 的全新 AI 工作台实现。本项目本地优先，未来按同一套应用代码验证 Linux 服务器部署。

## 开发边界

- 原项目基线完整保存在 reference/source，仅用于只读分析，并由根 .gitignore 排除。
- 新实现放在 portable/；禁止直接编辑或提交 reference/source 中的业务代码。
- GitHub 私有仓库只接收新实现、项目文档和测试。未经用户明确要求，不推送参考基线。
- 每个阶段先实现，再运行该阶段的自动化检查与平台验收；问题修复并复测通过后，才进入下一阶段。

## 当前阶段

当前阶段：阶段 2——界面框架与核心工作流。阶段 1 的新实现隔离、跨平台路径/日志/子进程基础和本机运行时已经验收；阶段 2 将开始实现可与原项目逐页对照的工作台界面。验收记录见 `docs/portability/PHASE-0-INVENTORY-AND-PLAN.md`。完整工作台与最终安装包尚未完成。

## 环境

- Node.js 22.13 或更高版本
- npm（本地开发）或 GitHub Actions 使用的 npm

创建首个本地管理员账号（仅在当前 Windows/macOS 用户账户下运行一次）：

    npm run account:create -- create-admin owner@example.com

命令生成高熵初始密码并仅显示一次；请妥善保存。账号摘要保存在应用用户数据目录的 `config/accounts.json`，不会公开注册，也不会把明文密码写入文件。首次登录必须设置新密码；改密后会撤销该账号其他已登录会话。

后续需添加普通成员时可运行：

    npm run account:create -- create-member user@example.com

运行当前自动化测试：

    npm test

启动本机工作台：

    npm start

先创建管理员，再运行 `npm start`，访问终端输出的本地 URL。通过 `ALLROUND_AI_PORT` 可更改监听端口；当前开发运行时只绑定本机回环地址，不对局域网或公网开放。当前账号模块是单进程本地实现；用于服务器、多进程或公网服务前还需完成数据库并发/备份策略、会话持久化、管理员恢复流程及安全部署验收。
