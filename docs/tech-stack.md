# fuxi-onlinemuseum 技术选型决策记录

> 本文不是菜单，是**决定**。每个决策点列出候选、结论和理由。
> 配套阅读：[backend-selection.md](./backend-selection.md)（方案对比）、[production-plan.md](./production-plan.md)（上线规划）。

---

## 0. 选型方法：五个问题定全部

做选型就是回答五个问题，后面的决定都是它们的推论：

1. 用户在哪？ → **国内**（中文界面、微信分享）
2. 谁来维护？ → **你一个人**（业余时间）
3. 要不要"自己搭"？ → **要**（目标就是做完整项目，不是为了快）
4. 预算？ → **每月 100~300 元可接受**
5. 规模预期？ → **中小**（参观型展厅，日活千级以内）

你的答案决定了下面的每一条。如果哪天第 3 或第 5 变了（不想运维了 / 突然流量爆炸），需要重新推演的只有第 3、4 节。

---

## 1. 后端运行时：**Node.js 20 + Express 5** ✅

| 候选 | 结论 |
|---|---|
| Node.js + Express | ✅ **选定** |
| Node.js + NestJS | 备胎：团队多人或接口超过 30 个时再迁移 |
| Go (Gin) / Python (FastAPI) | 放弃：与前端不同语言，一个人维护两套生态不值 |
| 云函数 (CloudBase) | 放弃：与"自己搭服务器"的目标冲突；作为退路保留 |

理由：前后端同语言（JS），你已有的工具链（`spz2ply`/`ply-meta` 都是 Node 脚本）可以直接搬进后端做上传流水线；Express 足够简单，出问题你能看懂每一行。

**项目结构**（从第一天就分层，避免烂成一团）：

```
server/
  src/
    routes/        路由（只做参数校验和调用 service）
    services/      业务逻辑（点赞去重、计数、审核）
    db/            Prisma schema 与查询
    middlewares/   auth(JWT)、rateLimit、errorHandler
    index.js       入口
  Dockerfile
```

---

## 2. 数据库：**PostgreSQL 16 + Prisma** ✅

| 候选 | 结论 |
|---|---|
| PostgreSQL 16 | ✅ **选定**，Prisma 一等公民，和将来可能的其他项目通用 |
| MySQL 8 | 完全可用，国内教程多；与 PG 二选一即可，别纠结 |
| MongoDB | 放弃：本项目数据全是关系（用户↔空间↔点赞），文档库反而别扭 |
| SQLite | 放弃（生产）：并发写锁；但本地开发用它完全没问题 |

部署：Docker Compose 里和后端一起跑在同一台轻量服务器；**每天定时 `pg_dump` 到 COS**，这是唯一不能省的运维。

---

## 3. 场景文件存储：**腾讯云 COS + CDN** ✅

- 唯一合理选择：46MB/场景的文件绝不能从业务服务器出流量
- 上传流程：前端要传 → 调后端 `/api/scenes/upload-url` → 后端校验登录态后签发 **COS 临时上传凭证**（限路径/限时/限类型）→ 前端直传 COS → 回调后端写 `scene_files` 记录
- 上传前把 PLY 转 **SPZ**（46MB→11MB，CDN 流量省 75%）；转换逻辑复用 `tools/spz2ply.mjs` 的逆过程，跑在后端
- CDN 开 Referer 白名单 + URL 签名，防盗链

---

## 4. 认证：**第一版用户名 + 密码 + JWT（httpOnly Cookie）** ✅

| 候选 | 结论 |
|---|---|
| 用户名/密码 + JWT | ✅ **选定**：零外部依赖，一天做完 |
| 手机号验证码 | 第二版再上：需要短信服务 + 实名，成本和流程都重 |
| 微信登录 | 需要企业主体资质（微信开放平台网站应用要求企业认证）；个人阶段做不了 |
| 第三方 OAuth (GitHub 等) | 受众不匹配，放弃 |

要点：token 放 **httpOnly + SameSite=Lax 的 Cookie**（比 localStorage 抗 XSS）；密码 bcrypt 哈希；JWT 7 天过期。

---

## 5. 服务器与部署：**腾讯云轻量服务器 + Docker Compose + Caddy** ✅

| 候选 | 结论 |
|---|---|
| 腾讯云轻量 2C2G (~60-112 元/月) | ✅ **选定**：性价比高，新用户常有优惠 |
| Docker Compose | ✅ `app` + `postgres` + `caddy` 三个容器，一条 `docker compose up -d` 部署 |
| Caddy | ✅ **选定**做反代 + HTTPS：自动申请续期证书，零配置（Nginx 也可，配置多） |
| Serverless (SCF) | 放弃：与自建目标冲突 |

**部署流水线**：本地 `git push` → 服务器 `git pull && docker compose up -d --build`（后期可加 GitHub Actions 自动 SSH 部署）。
**同一台服务器同时服务**：Caddy 静态托管前端 dist + 反代 `/api` → Node 后端；场景大文件单独走 COS+CDN。

---

## 6. 前端：**现有 esbuild 静态站不变，加 API 适配层** ✅

- 不引入 React/Vue 框架——现有 vanilla JS 结构清晰，重写没有收益
- 拆模块：`api.js / viewer.js / controls.js / ui.js`（见 production-plan.md 第 4 节）
- 加环境配置：`config/env.js` 区分 dev / prod 的 API 地址
- 前期继续挂 GitHub Pages 过渡，备案通过后迁到自己的 Caddy 服务器（切换只是改 DNS/上传位置）

---

## 7. 监控与统计：**自建错误上报 + UptimeRobot** ✅

- 前端 `window.onerror` → POST `/api/report-error`（写数据库，简单有效）
- UptimeRobot（免费）每 5 分钟拨测 `/api/health`，挂了发邮件
- 访问统计：浏览计数自己记（本来就要展示），不引第三方

---

## 8. 最终技术栈一览

```
┌─ 前端 ────────────────────────────────┐
│ Vanilla JS + three.js + @mkkellogg/…  │
│ esbuild 打包, 模块化 (api/viewer/…)    │
└──────────────┬────────────────────────┘
               │ HTTPS (fuxi3d.cn)
┌──────────────▼────────────────────────┐
│ 腾讯云轻量服务器 (Docker Compose)       │
│  ├ Caddy    反代 + 静态 + 自动HTTPS     │
│  ├ Node/Express  REST API + JWT        │
│  └ PostgreSQL 16  业务数据              │
└──────────────┬────────────────────────┘
               │ 场景大文件
        腾讯云 COS + CDN (.spz)
```

---

## 9. 决策对应的开发顺序（第一个月）

| 周 | 任务 | 产出 |
|---|---|---|
| 1 | 买域名提备案；服务器开通 + Docker Compose 跑起 Caddy + PG；Express hello world + JWT 登录注册 | `api.fuxi3d.cn`（备案前用 IP/测试域名）能登录 |
| 2 | Prisma 建表（users/spaces/likes/comments）；点赞/收藏/评论 API | 前端 api.js 接通，假数字变真 |
| 3 | COS 存储桶 + 直传凭证接口；SPZ 转换搬进后端；场景列表接口 | 可上传、可切换多场景 |
| 4 | 错误上报 + 拨测 + 备份脚本；真机测试；备案通过后切正式域名 | 上线 |

---

## 10. 什么时候需要推翻本决定

| 触发条件 | 动作 |
|---|---|
| 日活 > 5000 或数据库 CPU 持续 > 60% | 数据库迁腾讯云托管，应用加实例 |
| 要加私信/推荐/审核流 | Express 迁 NestJS（路由结构可平移） |
| 不想再运维 | 全套迁 CloudBase（数据模型一致，主要重写 API 层） |
| 受众转向海外 | 加 Supabase/Vercel 双线，国内线保留 |
