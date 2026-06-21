# AGENTS.md — 个人灵感库

## 产品边界

- 单用户、本地优先，不增加登录、团队、管理员或公司 SSO。
- 主数据存浏览器 IndexedDB；原始 Blob 必须保留，缩略图仅用于图库预览。
- 默认首屏 30 项并渐进加载，避免一次解码大量原图。
- 跨设备 v1 使用完整导出/导入；云同步属于后续独立模块。

## 当前运行入口

- `src/App.tsx`
- `src/pages/PersonalLibraryPage.tsx`
- `src/lib/localLibrary.ts`
- `src/index.css`

旧的 Appwrite/快手 SSO 文件仅来自原项目备份，不得重新接入当前入口或生产构建。

## 验证

修改后至少执行：

```bash
pnpm build
```

并用 Chrome 验证上传、详情下载原图、导出备份、导入恢复和插件采集。
