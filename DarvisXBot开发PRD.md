# DarvisXBot 开发 PRD

## 1. 项目概述

DarvisXBot 是一个面向 Telegram 群组和频道运营者的智能管理机器人。产品目标是帮助管理员完成群组治理、频道发布、成员验证、自动回复、抽奖活动、会员订阅、反垃圾、统计分析等工作。

机器人用户名：@DarvisXBot


## 2. 产品定位

### 2.1 目标用户

- Telegram 群组管理员
- Telegram 频道运营者
- 社群运营团队
- 需要会员群、付费频道、抽奖活动的项目方
- 需要自动化管理多个群组和频道的个人或团队

### 2.2 核心价值

- 降低 Telegram 群组和频道管理成本
- 用机器人菜单完成常见管理配置
- 提供自动化规则，减少人工审核
- 支持多群组、多频道统一管理
- 支持抽奖、会员、统计等运营功能


## 3. 产品形态

### 3.1 Telegram Bot

用户主要通过 Telegram 私聊机器人完成配置，也可以在群组中使用管理员命令。

### 3.2 Web 管理后台

用于复杂配置和数据查看，例如群组列表、频道列表、成员数据、抽奖记录、会员订单、操作日志等。

### 3.3 后端服务

负责 Telegram Webhook、业务逻辑、权限校验、定时任务、消息队列、数据库读写。


## 4. MVP 范围

第一版目标是做出可真实使用的群组/频道管理基础版本，不追求一次性覆盖所有高级功能。

### 4.1 Bot 基础能力

- /start 主菜单
- 语言切换
- 时区设置
- 用户身份识别
- 管理员权限检测
- 绑定群组
- 绑定频道
- 当前管理对象切换
- Inline Keyboard 菜单交互
- 操作成功/失败提示

### 4.2 群组管理

- 欢迎语设置
- 入群验证
- 新成员限制
- 关键词过滤
- 链接过滤
- 自动删除消息
- 禁言用户
- 踢出用户
- 封禁用户
- 解封用户
- 管理员操作日志
- 群组命令开关

### 4.3 频道管理

- 绑定频道
- 快捷发布
- 定时发布
- 草稿消息
- 按钮链接配置
- 发布记录查看

### 4.4 自动化规则

- 自动回复
- 定时消息
- 违禁词规则
- 链接白名单
- 夜间模式
- 反垃圾基础规则

### 4.5 抽奖系统

- 创建抽奖
- 设置奖品名称
- 设置中奖人数
- 设置开奖时间
- 用户点击按钮参与
- 限制重复参与
- 校验用户是否在指定群组或频道内
- 自动开奖
- 开奖结果公示
- 抽奖记录保存

### 4.6 会员订阅

- 查看会员状态
- 设置会员有效期
- 到期提醒
- 到期自动移除群组或频道
- 手动开通会员
- 手动取消会员
- 订单记录预留

### 4.7 统计功能

- 群组新增成员统计
- 群组退群统计
- 消息数量统计
- 活跃用户统计
- 抽奖参与人数统计
- 会员数量统计


## 5. 非 MVP 功能

以下功能不放入第一版，但需要在架构上预留扩展能力。

- AI 智能审核
- 色情图片检测
- 多机器人托管
- 多租户套餐计费
- Telegram Stars 支付
- 第三方支付
- 高级风控评分
- 群组成员完整导入
- 批量迁移配置
- 多语言完整国际化
- 团队成员和角色权限
- 公开 API
- 插件系统


## 6. 主要页面和菜单

### 6.1 /start 首页菜单

- 设置频道
- 设置群组
- 快捷发布
- 订阅会员
- 克隆配置
- 设置时区
- Languages

### 6.2 群组设置菜单

- 定时消息
- 自动回复
- 进群验证
- 进群欢迎
- 控制权限
- 邀请链接
- 群组统计
- 人数统计
- 夜间模式
- 群组命令
- 自动删除
- 发言检查
- 违禁词
- 反垃圾
- 抽奖
- 积分
- 屏蔽
- 导入配置
- 群组成员
- 新成员限制
- 开关群
- 色情检测
- 切换群
- Languages

### 6.3 频道设置菜单

- 绑定频道
- 快捷发布
- 定时发布
- 草稿箱
- 按钮配置
- 发布历史
- 频道统计
- 频道权限检查


## 7. 权限要求

DarvisXBot 需要被添加为群组或频道管理员。不同功能需要不同权限。

### 7.1 群组权限

- 删除消息：用于关键词过滤、反垃圾、自动删除
- 封禁用户：用于踢人、封禁、入群验证失败处理
- 限制用户：用于禁言、新成员限制
- 邀请用户：用于生成邀请链接和会员入群
- 置顶消息：用于公告和重要消息
- 管理视频聊天：非 MVP，可暂不需要

### 7.2 频道权限

- 发布消息：用于快捷发布和定时发布
- 编辑消息：用于修改已发布内容
- 删除消息：用于撤回发布内容
- 邀请用户：用于会员频道邀请链接


## 8. Telegram API 限制

- Bot 不能直接获取所有历史成员列表。
- 群成员统计通常只能从 Bot 加入群后开始记录。
- Bot 需要关闭 BotFather 的 privacy mode，才能读取群组普通消息用于过滤和统计。
- 频道订阅关系校验依赖 getChatMember，但需要 Bot 在目标频道内且具备权限。
- 用户主动私聊过 Bot 后，Bot 才能主动向用户发送私聊消息。
- 批量踢人、批量消息处理需要考虑 Telegram API 速率限制。


## 9. 推荐技术架构

### 9.1 后端

- Node.js
- TypeScript
- grammY
- PostgreSQL
- Redis
- BullMQ 或类似任务队列
- Prisma 或 Drizzle ORM

### 9.2 前端后台

- React 或 Next.js
- Tailwind CSS
- shadcn/ui 或自建组件库

### 9.3 部署

- Docker Compose
- Nginx
- HTTPS 域名
- Telegram Webhook


## 10. 数据模型初稿

### 10.1 users

- id
- telegram_user_id
- username
- first_name
- last_name
- language_code
- timezone
- created_at
- updated_at

### 10.2 chats

- id
- telegram_chat_id
- type
- title
- username
- owner_user_id
- timezone
- status
- created_at
- updated_at

### 10.3 chat_admins

- id
- chat_id
- user_id
- role
- permissions
- created_at
- updated_at

### 10.4 settings

- id
- chat_id
- key
- value
- created_at
- updated_at

### 10.5 moderation_rules

- id
- chat_id
- rule_type
- pattern
- action
- enabled
- created_at
- updated_at

### 10.6 scheduled_messages

- id
- chat_id
- content_type
- content
- buttons
- send_at
- repeat_rule
- status
- created_at
- updated_at

### 10.7 giveaways

- id
- chat_id
- title
- description
- prize
- winners_count
- join_requirements
- draw_at
- status
- created_by
- created_at
- updated_at

### 10.8 giveaway_entries

- id
- giveaway_id
- user_id
- joined_at
- is_valid

### 10.9 memberships

- id
- user_id
- chat_id
- starts_at
- expires_at
- status
- source
- created_at
- updated_at

### 10.10 audit_logs

- id
- chat_id
- actor_user_id
- action
- target_type
- target_id
- metadata
- created_at


## 11. 开发阶段计划

### 阶段一：基础框架

- 初始化项目
- 接入 Telegram Bot
- 配置 Webhook
- PostgreSQL 数据库
- Redis 连接
- 用户表和群组表
- /start 菜单
- 权限检查

### 阶段二：群组基础管理

- 绑定群组
- 欢迎语
- 入群验证
- 关键词过滤
- 链接过滤
- 自动删除
- 管理员日志

### 阶段三：频道和发布

- 绑定频道
- 快捷发布
- 定时发布
- 草稿消息
- 发布记录

### 阶段四：抽奖和会员

- 抽奖创建
- 抽奖参与
- 自动开奖
- 会员有效期
- 到期提醒
- 到期移除

### 阶段五：后台管理

- 登录
- 群组列表
- 频道列表
- 规则配置
- 统计面板
- 操作日志


## 12. 验收标准

### 12.1 Bot 验收

- 用户发送 /start 后能看到主菜单。
- 管理员能绑定自己管理的群组。
- Bot 能识别群组管理员权限不足并提示补充权限。
- 欢迎语、关键词过滤、链接过滤可以正常启停。
- 定时消息可以按设定时间发送。
- 抽奖可以创建、参与、开奖并保存记录。
- 会员到期后可以提醒并执行移除操作。

### 12.2 后台验收

- 管理员可以登录后台。
- 可以查看已绑定群组和频道。
- 可以查看基础统计。
- 可以查看操作日志。
- 可以修改基础规则配置。

### 12.3 稳定性验收

- Bot 服务异常重启后不丢失配置。
- 定时任务重启后仍可继续执行。
- Telegram API 调用失败时有重试和错误日志。
- 数据库迁移可重复执行。


## 13. 风险和注意事项

- Telegram API 权限和速率限制会影响部分功能体验。
- 色情检测和 AI 审核需要额外模型或第三方服务，成本较高。
- 会员和支付功能涉及合规问题，需要根据目标地区选择支付方式。
- 多机器人托管涉及租户隔离和 Token 安全，不建议第一版直接做复杂。
- 如果未来做商业化，需要尽早设计套餐、限额、日志留存和数据备份。


## 14. 第一版推荐交付物

- Bot 后端服务
- PostgreSQL 数据库结构
- Redis 队列
- Docker Compose 部署文件
- Telegram Webhook 接入
- 群组管理 MVP
- 频道发布 MVP
- 抽奖 MVP
- 会员有效期 MVP
- 基础 Web 后台
- 部署文档
