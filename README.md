# LatAm Collector

面向巴西跨境电商选品的本地数据管理与采集平台。v0.3 支持 Shopee 商品、销量和评论公开响应采集，以及销量口径控制、趋势追踪、选品参考分和消费者声音分析。

Chrome 采集助手可在正常浏览 Shopee 巴西站时捕获支持的商品与评论 JSON，并发送到本机平台，不读取 Cookie、密码或请求头。

## PowerShell 一键安装（推荐）

以普通方式打开 Windows PowerShell，依次运行：

```powershell
$setup = "$env:TEMP\install_latam_collector.ps1"
Invoke-WebRequest "https://raw.githubusercontent.com/ihzzy630-crypto/LatAmCollector/main/install_windows.ps1" -OutFile $setup
powershell -ExecutionPolicy Bypass -File $setup
```

安装脚本会把程序放在 `D:\gpt专用文件\LatAmCollector`，创建独立虚拟环境和桌面快捷方式，并保留已有的 `data` 数据库。请勿使用管理员身份运行，除非公司的软件安装策略明确要求。

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
- 月销量/累计销量口径切换、上下限、增长量与可信度筛选
- 价格区间、评分、评论数、上架年份、地区、分类和关键词筛选
- 同一商品重复采集后的销量、月销和价格变化追踪
- 选品参考分、生命周期、收藏候选与业务备注
- 2025—2026 评论情绪、主题、媒体和关键词筛选
- SQLite 本地存储和重复数据更新
- 商品及评论 CSV/Excel 导出
- 任务配置、数据源状态和运行日志
- 只监听本机 `127.0.0.1`，不会对局域网或互联网开放管理端
- Chrome 自动采集助手（`chrome_extension` 文件夹）

## 安装 Chrome 采集助手

1. 在 Chrome 打开 `chrome://extensions`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `D:\gpt专用文件\LatAmCollector\chrome_extension`。
5. 保持本地平台运行，打开或刷新 Shopee 巴西站页面。

## 后续接口

采集连接器计划采用独立适配器：Shopee Chrome 采集助手、SHEIN 连接器、Mercado Livre 官方 API/公开数据连接器。网站接口改变时只替换连接器，不修改商品库与任务中心。

