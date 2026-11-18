# LatAm Collector

面向巴西跨境电商选品的本地数据管理与采集平台。第一版支持 Shopee 搜索、热门推荐、评论 JSON 导入，商品筛选以及 Excel/CSV 导出。

## Windows 直接运行

1. 将整个 `latam_collector` 文件夹复制到 `D:\gpt专用文件\LatAmCollector`。
2. 双击 `run_windows.bat`。
3. 首次运行会安装依赖，之后浏览器自动打开 `http://127.0.0.1:8765`。
4. 在“数据导入”页面选择 Shopee 原始 JSON。

## 生成 EXE

双击 `build_windows.bat`。完成后程序位于：

`dist\LatAmCollector.exe`

将 EXE 放在一个单独文件夹中运行。程序会在 EXE 旁创建 `data` 文件夹，所有本地数据库都保存在其中。

## 当前能力

- Shopee `search_items` 和 `recommend_v2` 商品数据解析
- Shopee `get_ratings` 评论数据解析
- 价格、销量、上架年份、分类和关键词筛选
- SQLite 本地存储和重复数据更新
- 商品及评论 CSV/Excel 导出
- 任务配置、数据源状态和运行日志
- 只监听本机 `127.0.0.1`，不会对局域网或互联网开放管理端

## 后续接口

采集连接器计划采用独立适配器：Shopee Chrome 采集助手、SHEIN 连接器、Mercado Livre 官方 API/公开数据连接器。网站接口改变时只替换连接器，不修改商品库与任务中心。

