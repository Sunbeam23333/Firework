# Firework · 我们的小蚂蚁

小小金、小蚂蚁，一只爱吃星星糖的小宠物，一本慢慢写满的共同日记。

前端继续发布在 [GitHub Pages](https://sunbeam23333.github.io/Firework/)，共享记忆由 Sites Worker + D1 保存。宠物回应来自预设文案和已存纸条，目前没有接入语言模型。

## 一起使用

- 两人第一次都打开同一个专属邀请链接，各自选择自己的名字。设备会记住选择；名字是署名，不是账号认证。
- 邀请链接的 `#key=` 是小窝钥匙，持有者可以读写回忆。请只分享给对方，不要提交进公开仓库。
- 投喂、陪伴、纸条立即写入本机待同步队列，联网时上传；页面可见时约每 15 秒同步，重新打开或恢复联网也会同步。
- 共同小火花统一使用北京时间。两位当天均互动，就点亮一天；累计天数不会因中断而清零。
- 设置里可复制邀请链接、改名字、导入和导出记忆。旧版浏览器记忆保留，点击“把这台设备的旧回忆带进来”才会上传。
- 清理浏览器数据后，用邀请链接能找回已同步记忆；未同步的内容请先导出。容量为 10000 条互动，不自动删除旧纸条。
- 公共页面不包含访问钥匙，未持有邀请链接的访客无法读取共同记忆。浏览器清理会忘记钥匙，请保留邀请链接。

## 开发与验证

Node.js 20+；测试还需要 Python 3（用真实 SQLite 验证数据库查询）。

```sh
npm ci
npm test
npm run dev
npm run build
```

静态预览在 `http://127.0.0.1:4173`。生产 API 限定 GitHub Pages 来源，本地预览只用于页面检查；`tests/shared.test.js` 用独立临时数据库运行双设备同步、离线重试、并发追加、认证、CORS 和名字版本冲突测试，不写入正式回忆。

- `dist/client`：GitHub Pages 静态产物；推送 main 后自动测试并发布。
- `dist/server/index.js`：共享服务 Worker；`.openai/hosting.json` 关联 Sites 项目。
- `db/schema.ts`、`drizzle/`：由 Drizzle 生成的数据库迁移；已应用迁移不可改写。
- Worker 环境变量：`ROOM_KEY_HASH` 为 32 字节随机 base64url 邀请钥匙的 SHA-256 十六进制摘要，存为服务端 secret；`ALLOWED_ORIGIN` 为 `https://sunbeam23333.github.io`。
- 不把邀请钥匙、账户 token 或个人记忆放入仓库、静态产物或 URL query。邀请片段读入后会从地址栏移除。

原始蚂蚁美术来源见 [ASSETS.md](ASSETS.md)。
