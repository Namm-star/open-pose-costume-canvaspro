# Open Pose & Costume · AI CanvasPro 本地版

[English](README.en.md)

基于 Hongye 维护的 [Open Pose & Costume](https://github.com/hongye007/open-pose-costume) 修改的本地参考图工作台。它面向角色设计、绘画练习和 AI 创作，提供姿势、服饰、人物参考图的中英文筛选、收藏与搭配，并可以用选中的参考图生成完整角色。

## 原项目与致谢

- 原项目提供图库、姿势多视角与部分深度图、收藏与搭配板、提示词组合及生成结果对照界面。原作者、在线版及配套工具可在上游查看。[原项目](https://github.com/hongye007/open-pose-costume) · [Hongye](https://x.com/HongyeMain) · [原版在线体验](https://omilic.com/) · [原版配套 Skill](https://github.com/hongye007/open-pose-costume-skill)
- 本地版基于上游提交 `16e378aaf0dd021b8e06001b4e1ed781580287ba`。上游继续由 Hongye 和原项目贡献者维护，本仓库由 Namm-star 维护。[基线源码](https://github.com/hongye007/open-pose-costume/tree/16e378aaf0dd021b8e06001b4e1ed781580287ba)
- 姿势、服饰及深度图来源包括 ギア 的图库，人物素材来源包括 あぎ 的图库，原项目的中文姿势名称含 Anhao 的贡献。原站、作者及具体授权条款见项目内的来源记录。[素材来源](SOURCES.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

## 本地版改动

- 「生图设置」接入 AI CanvasPro 图片模型，覆盖同步、异步图生图和服饰提取。配置项包括自己的 API Key、模型、尺寸和质量。[AI CanvasPro API 文档](https://api.canvasproai.com/docs)
- 本地 Vite 中继负责转发参考图和模型请求。界面分别显示参考图准备、提交、等待和下载阶段，并显示平台返回的错误信息。
- 异步任务得到任务号后可继续查询。取图遇到临时网络错误时会按任务号自动再查一次，用户也可从页面手动取回。保留原参考图的任务在取回结果后可继续用双列和叠加预览对照。
- 密钥默认为空。填写后默认保存在当前浏览器会话，勾选「在此浏览器记住密钥」后保存在该浏览器。生成或提取服饰时，选择的参考图及描述会传给 AI CanvasPro。

## 本地运行

需要 Node.js 22.12 或更高版本。在仓库目录运行：

```sh
npm ci
npm run dev
```

打开 [http://127.0.0.1:5199](http://127.0.0.1:5199)，在「一键生图」的「生图设置」里填写自己的 AI CanvasPro API Key，选择模型并保存。无需创建 `.env`。本地生图请求由 Vite 服务转发。构建产物中的静态页面需要配套中继才能生图。

### 接入本地图库

GitHub 仓库包含代码和授权说明。完整图库需要在本机提供按原条款可使用的素材，首次检出后缺少目录数据时页面会提示图库加载失败。可以从有权使用的原项目副本，按下表复制到本地版相同路径：

| 原项目路径 | 用途 |
| --- | --- |
| `public/data/catalog.json` | 图库索引，包含按需从原站读取的参考图地址 |
| `public/custom/` | 索引中的自建素材，须遵守对应的素材授权 |
| `public/brand/`、`public/images/`、`public/guide/` 和 `public/` 下的图标 | 可选的首页、使用指南和图标素材 |
| `data/` 中的图库清单和来源数据 | 运行原项目素材构建脚本或完整测试时需要。在已有本地词汇表和许可说明的基础上补齐这些文件 |

项目已有的本地图库可直接使用。外部图库文件已配置 Git 忽略规则。

## 构建与测试

```sh
npm run test:code
npm run build
```

代码测试使用模拟接口和本地测试图片，覆盖参考图传输、异步结果取回及生图配置，无需平台密钥。按上节补齐图库文件后可运行 `npm test`，额外检查素材索引、来源数据和筛选功能。

## 许可证

应用源码、脚本、测试及项目文档采用原项目的 MIT 许可，本仓库保留上游版权和许可声明。图片、第三方目录数据和翻译各自适用原有条款。自建素材的分发及商业使用需要另行取得授权。[代码许可证](LICENSE) · [自建素材许可](public/custom/LICENSE.txt) · [素材来源和授权](SOURCES.md)
