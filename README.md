# 叠个饭

小蚕霸王餐与美团试吃官同店比价工具，支持活动同步、返现试算与数据导入。

## 功能特性

| 功能 | 支持范围 |
| --- | --- |
| 账号连接 | 小蚕本人小程序会话导入、美团官方短信登录窗口 |
| 活动同步 | 同一收餐地址查询两平台当前第一页活动 |
| 同店匹配 | 门店 ID、完整分店名与待核验候选 |
| 价格计算 | 固定返现、比例返现、门槛、上限、名额与有效时段 |
| 活动管理 | 搜索、筛选、排序、收藏、CSV 导出 |
| 数据导入 | 两平台 JSON 模板，最多 500 条活动 |
| 界面 | 桌面与移动端尺寸适配 |

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 应用 | Nuxt 4、Vue 3、TypeScript |
| 服务端 | Nitro、Node.js |
| 官方登录窗口 | Playwright Core、Google Chrome |
| 图标 | Lucide Vue |
| 会话存储 | AES-256-GCM 加密文件 |
| 开发工具 | tsx、vue-tsc、Prettier |

## 环境要求

- Node.js 22 或更高版本、npm。
- Google Chrome，用于打开美团官方登录窗口。
- 通过 `localhost` 或 `127.0.0.1` 访问；服务默认绑定 `127.0.0.1`。

## 安装与快速开始

```bash
npm install
npm run dev
```

访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。设置收餐地址，在「账号管理」连接平台后同步活动，或导入已有活动数据。

生产运行：

```bash
npm run build
npm start
```

## 账号连接

### 小蚕霸王餐

在微信小蚕小程序登录后，将本人 `https://gw.xiaocantech.com/rpc` 请求的 cURL 或请求头 JSON 导入「账号管理」。请求需要 `X-Teemo`、`X-Vayne` 及相应会话字段。

当前支持小程序会话导入，未接入小蚕原生短信或微信授权登录。参考项目的用户登录属于其自建服务，不是小蚕官方登录。

### 美团试吃官

在「账号管理」打开登录窗口，完成美团官方短信登录和安全验证，再选择「验证登录」。会话失效后需重新登录；安全校验由官方页面处理。

## 价格计算

到手价试算 = 订单实付 − 小蚕返现 − 美团返现。

返现分别校验门槛、时段与名额，比例返应用金额上限。计算器支持填写不计返现费用，以及确认分店和叠加条件。使用美团活动页优惠券的订单不参与试吃官返现。

同步失败保留上次成功数据；同步间隔为 30 秒。不同活动分别计算。

## 数据导入

在「账号管理」选择平台并导入 JSON 数组。下载模板为空数组，需要填入实际活动。金额单位为分，活动 ID 必须唯一。

| 字段 | 格式 | 说明 |
| --- | --- | --- |
| `id` | 字符串 | 活动唯一 ID，必填 |
| `name` | 字符串 | 完整店铺及分店名称，必填 |
| `rule` | 对象 | 返现规则，必填 |
| `meituanPoiId` | 字符串 | 美团门店 ID |
| `inventory` | 非负整数 | 剩余名额 |
| `startTime`、`endTime` | `HH:mm` | 有效时段 |
| `requirement` | 字符串 | 任务要求 |

| 规则 | `kind` | 必填金额字段 |
| --- | --- | --- |
| 固定返现 | `fixed` | `thresholdCents`、`cashbackCents` |
| 比例返现 | `percentage` | `thresholdCents`、`ratioBps`、`capCents` |

`ratioBps` 使用基点，`capCents` 为返现上限。可选字段包括 `category`、`address`、`distanceMeters`、HTTPS `image` 和 `url`。

## 配置

环境变量模板见 [.env.example](.env.example)。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `FOOD_BROWSER_PATH` | Chrome 可执行文件路径 | 使用已安装的 Google Chrome |
| `FOOD_DATA_DIR` | 加密会话文件目录 | `.data/food` |

生产入口从启动环境读取变量，不自动加载 `.env`。会话目录内的密钥和加密文件需共同备份。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 开发服务 |
| `npm run build` | 生产构建 |
| `npm start` | 生产服务 |
| `npm test` | 计算规则与数据适配器测试 |
| `npm run test:integration` | 生产 API 集成测试 |
| `npm run typecheck` | 类型检查 |
| `npm run format` | 源码格式化 |

## 相关入口

- [小蚕参考项目](https://github.com/lyrric/xiaochan)
- [Nuxt 文档](https://nuxt.com/docs)
