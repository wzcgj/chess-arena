# 部署指南 · Chess Arena

国际象棋竞技场（四档 AI 单机对战 + 思路解说 + 联网对战 + 账号棋谱云存）的免费云端部署方案。
后端是 Node 服务（含 WebSocket 联网对战），因此不能用纯静态托管，必须用能跑 Node 进程的平台。

**技术选型**
- 应用平台：**Render 免费 Web Service**（原生支持 Node + WebSocket）
- 数据持久：**Supabase（免费 Postgres）**——因为 Render 免费版磁盘是临时的，账号和棋谱必须放外部数据库，否则容器重启/休眠会清空。

---

## 一、Supabase：建数据库

1. 打开 https://supabase.com ，用 **GitHub 登录**，点 **New project**（免费）。
   - 填项目名（如 `chess-arena`）、设一个数据库密码（记一下），选区域，Create。
   - 初始化约 30 秒，请等它完成。

2. 建表（运行 schema 脚本）：
   - 左侧边栏点 **SQL Editor**（数据库图标）→ **New query**。
   - 把本仓库 `supabase/schema.sql` 的内容整段粘贴进去。
   - 点 **Run**（或 Ctrl/Cmd+Enter）执行，看到 `Success` 即建好 `users` / `tokens` / `games` 三张表。

3. 拿连接凭证（给 Render 用）：
   - 左侧边栏最底下点 **⚙️ Settings** → 选 **API**。
   - 复制 **Project URL**（形如 `https://xxxxxxxx.supabase.co`）→ 这是 `SUPABASE_URL`。
   - 往下找 **Project API keys** → 复制 **`service_role` `secret`** 那个 key → 这是 `SUPABASE_SERVICE_ROLE_KEY`。
   - ⚠️ 用 `service_role`（不是 `anon`），它是服务端密钥，只配置在后端/Render 环境变量，前端代码绝不持有它。

---

## 二、Render：部署应用

1. 打开 https://render.com ，登录后 **New → Web Service**。
2. 选 **Connect a repository** → 授权 GitHub → 选仓库 **`chess-arena`**（分支 `main`）。
3. 部署配置（本仓库已带 `render.yaml`，Render 会自动读取；如需手动填）：
   - **Runtime**：Node
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Health Check Path**：`/`
   - **Plan**：Free
4. 在 **Environment Variables** 里填两项：
   | Key | Value |
   |-----|-------|
   | `SUPABASE_URL` | 上面复制的 Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | 上面复制的 service_role key |
5. 点 **Create Web Service / Deploy**。
   - 首次构建约 1–2 分钟。免费版约 15 分钟无访问会**休眠**，首次访问冷启动 30–50 秒，属正常。
   - 部署完成后 Render 会给一个 `https://chess-arena-xxxx.onrender.com` 域名，直接访问即可游玩。

---

## 三、部署后验证

- 访问 Render 提供的域名，确认棋盘加载、能选难度并和 AI 对弈、右侧思路面板正常。
- 注册一个账号 → 下一局联网/单机 → 结束后再进「我的棋谱」能看到这局（数据在 Supabase，重启/休眠不丢）。
- 联网对战：开两个浏览器标签（或一个隐身窗）各注册一个号，切到「联网对战」互相匹配、走子实时同步。

---

## 四、本地开发 & 与 GitHub 同步

> 注意：本仓库代码最初是通过 GitHub API 推送的，因此**你本地 git 仓库的 `main` 提交历史与 GitHub 远端 `main` 不同源**（内容一致，但 commit 对象不同）。

- 建议直接 `git clone https://github.com/wzcgj/chess-arena.git` 一份新副本做后续开发，避免历史冲突。
- 若要在原本地仓库继续：`git fetch` 后 `git reset --hard origin/main`（需网络可访问 GitHub）。
- 本地跑起来：`npm install` → `npm start` → 访问 `http://localhost:3000`。
  本地未设 Supabase 环境变量时，存储会自动降级为本地 JSON 文件（`data/users.json` / `data/games.json`），不影响开发调试。

---

## 五、常见问题

- **部署后账号/棋谱为空或报错**：多半是没跑 `supabase/schema.sql`，或 `SUPABASE_*` 环境变量填错/漏填。检查 Render 环境变量并确认三张表已建。
- **连不上 Supabase**：确认用的是 `service_role` key（不是 anon），且 `SUPABASE_URL` 不带末尾斜杠。
- **联网对战休眠时连不上**：免费版休眠所致，访问一次唤醒即可；或升级 Render 付费 plan 关闭休眠。
- **本地改了代码要更新线上**：`git push` 到 `main`，Render 会自动重新构建部署（前提是本地 git 历史已与远端对齐，见第四节）。

---

## 附：本仓库部署相关文件

- `render.yaml` —— Render 部署清单（构建/启动/健康检查）
- `supabase/schema.sql` —— 数据库建表脚本
- `server/store.js` —— 存储层：有 `SUPABASE_*` 环境变量时用 Postgres，否则降级本地 JSON
- `server/index.js` / `server/play.js` —— 后端服务与 WebSocket 联网对战
