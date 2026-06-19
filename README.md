# pixiv-snap

> 在 Pixiv 作品页一键下载插画、漫画、动图与小说的用户脚本

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GreasyFork](https://img.shields.io/badge/GreasyFork-安装-red)](https://greasyfork.org/scripts/你的脚本ID)

---

## 功能

| 内容类型 | 下载行为 |
|---|---|
| 插画（单页） | 直接下载原图 |
| 插画 / 漫画（多页） | 自动打包为 ZIP，附带元数据 JSON |
| 动图（Ugoira） | 下载原始帧 ZIP + 帧时序 JSON |
| 小说 | 下载带元数据头部的 TXT，附带元数据 JSON |

- 复用浏览器已登录的 Cookie，无需额外配置 API Key
- 悬浮按钮 + 可展开面板，支持进度显示与下载日志
- 并发下载，速度快，自动重试失败页
- 支持 Pixiv SPA 路由，无刷新跳转作品后自动更新状态

---

## 安装

### 前置要求

需要浏览器安装以下任一用户脚本管理器：

- [Tampermonkey](https://www.tampermonkey.net/)（推荐，Chrome / Firefox / Edge）
- [Violentmonkey](https://violentmonkey.github.io/)

### 安装脚本

**方式一：通过 GreasyFork 一键安装（推荐）**

点击：[→ 安装 pixiv-snap](https://greasyfork.org/scripts/你的脚本ID)

**方式二：手动安装**

1. 下载本仓库中的 [`pixiv-snap.user.js`](pixiv-snap.user.js)
2. 在脚本管理器中选择「从文件安装」

---

## 使用方法

1. 在浏览器登录 Pixiv
2. 打开任意作品页（插画、漫画、动图、小说均支持）
3. 点击页面右下角的悬浮按钮展开面板
4. 点击「下载当前作品」

下载完成后文件会直接触发浏览器下载，保存至默认下载目录。

---

## 配置

脚本顶部 `CONFIG` 对象支持自定义：

```js
const CONFIG = {
  position: 'bottom-right',   // 按钮位置：bottom-right / bottom-left / top-right / top-left
  margin: 24,                  // 距边缘距离（px）
  zipNameTpl: '{title}',       // ZIP 文件名模板
  fileInZipTpl: '{title}_{index}', // ZIP 内文件名模板
  singleFileTpl: '{title}',    // 单图文件名模板
  ugoiraNameTpl: '{title}_ugoira', // 动图文件名模板
  novelNameTpl: '{title}',     // 小说文件名模板
  concurrency: 3,              // 并发下载数
  imageTimeoutMs: 180000,      // 单图超时（ms）
};
```

模板变量：`{title}` 作品标题、`{id}` 作品 ID、`{author}` 作者名、`{index}` 页码。

---

## 免责声明

- 本脚本仅供个人学习与研究使用，**请勿用于任何商业用途**。
- 本脚本通过复用浏览器登录状态访问 Pixiv 公开 API，与官方客户端行为一致，但使用本脚本**可能违反 Pixiv 用户服务协议**，由此产生的账号风险由使用者自行承担。
- 下载内容的版权归原作者所有，**请尊重创作者权益，不得二次传播或用于商业用途**。
- 本项目作者不对因使用本脚本导致的账号封禁、数据丢失或任何其他损失承担责任。

---

## 致谢

- [PixivFlow](https://github.com/zoidberg-xgd/PixivFlow)：本项目开发过程中参考了其功能设计思路，感谢原作者的工作与开源贡献。

---

## License

[MIT](LICENSE) © 2026 Everaine0