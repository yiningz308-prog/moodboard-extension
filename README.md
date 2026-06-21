# Moodboard Extension

一个将 Pinterest、花瓣、小红书等网站的图片和视频保存到灵感库的 Chrome 扩展。

## 功能

- 通过右键菜单保存图片、GIF 和视频。
- 识别 Pinterest 原图、花瓣 CDN 原图和小红书媒体地址。
- 在花瓣网站提供不依赖原生右键菜单的悬浮保存按钮。
- 复用灵感库网站的登录状态，将媒体转存到 Appwrite Storage。

## 开发者加载

1. 打开 `chrome://extensions/`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择 `project+001+灵感库浏览器插件/src/moodboard-extension`。

## 配置说明

当前代码包含特定环境的灵感库域名和 Appwrite 项目标识。用于其他环境前，请修改 `background.js`、`save.js` 和 `manifest.json` 中的相关配置。不要向仓库提交密钥或访问 Token。
