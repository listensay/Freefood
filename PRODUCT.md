# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

匹配小蚕霸王餐与美团试吃官的同一家店，计算价格叠加，并提供两个平台的账号连接入口。

## Evidence on Hand

- 用户指定参考 https://github.com/lyrric/xiaochan 。数据逻辑位于 XiaochanHttp.java。
- 用户提供美团 offsiteact.meituan.com 活动页面，已检查官方登录组件、活动响应和优惠券互斥提示。
- 当前为 Nuxt 4 / Vue 3 项目，没有既有视觉实现或用户提供的真实账号数据。
- 示例活动必须明确标注为模拟数据。

## Capabilities and Constraints

- 小蚕参考项目没有小蚕官方登录接口，其用户登录不是官方登录。
- 美团使用官方登录与风控组件，用户自行完成短信与安全验证。
- 小蚕先导入本人已登录小程序的请求会话；不是原生小蚕短信登录，官方身份登录接口仍待提供。
- 会话按浏览器隔离并在本机加密，当前只允许 localhost 使用。
- 公式暂定为实付减两边返现，待用户确认；同店不代表两平台一定能同时归因。
- 独立处理优惠券、门槛、时段、名额、比例上限与金额精度。
- 自动同步当前第一页，避免高频批量抓取。更大数据集可通过 JSON 导入。

## Open Decisions

受众、品牌名称、部署要求未确认。“叠个饭”为本次实现的工作名称，未写入长期工作流偏好。
