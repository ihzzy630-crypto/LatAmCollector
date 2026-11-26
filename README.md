# LatAm Collector

面向巴西跨境电商选品的本地数据管理与采集平台。选品雷达 v0.6.0 为 Shopee 与 SHEIN 商品统一中文品类，支持分组筛选、匹配数量和手动改类。平台也支持商品和评论采集、销量与价格追踪、收藏和备注。

Chrome 采集助手可在正常浏览 Shopee / SHEIN 巴西站时整理支持的公开商品与评论响应，并发送到本机平台，不读取密码或请求头。

v0.3.1 起，安装器会创建 Windows 登录时的静默启动项。桌面快捷方式会自动检查并启动本地服务，不再要求长期保留 PowerShell 窗口。

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
4. 在“数据导入”页面选择 Shopee 或 SHEIN 原始 JSON。

## 更新选品雷达

已经安装本地平台时，解压雷达更新包，把其中的 `app` 和 `static` 文件夹复制到 `D:\gpt专用文件\LatAmCollector`，选择替换文件。重启本地平台后，左侧版本显示 v0.6.0。使用 Windows 登录自启动的用户可以退出 Windows 登录后再登录。

首次启动会整理商品库里的旧品类，随后按平台品类和葡语标题为新商品归类。品类旁的数字按当前应用的筛选条件计算。可以在商品右侧点击“改品类”纠正自动结果，也可以随时恢复自动分类。

## 生成 EXE

双击 `build_windows.bat`。完成后程序位于：

`dist\LatAmCollector.exe`

将 EXE 放在一个单独文件夹中运行。程序会在 EXE 旁创建 `data` 文件夹，所有本地数据库都保存在其中。

## 当前能力

- Shopee `search_items` 和 `recommend_v2` 商品数据解析
- Shopee 列表/详情多种图片字段兼容、商品缩略图、缺图筛选、历史数据自动补图和导出图片链接
- Shopee `get_ratings` 评论数据解析
- SHEIN 商品列表卡片与公开商品接口解析
- SHEIN 公开评论接口解析
- SHEIN 安全节奏滚动、严格识别真实分页、重复页去重，以及验证/空结果/拒绝访问/翻页停滞时暂停并保留进度
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
- 当前分类或搜索列表一键批量分页，默认最多 3000 件、每 3 秒一批
- 批量任务进度、主动暂停与同一列表续采

## 安装 Chrome 采集助手

1. 在 Chrome 打开 `chrome://extensions`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `D:\gpt专用文件\LatAmCollector\chrome_extension`。
5. 保持本地平台运行，打开或刷新 Shopee / SHEIN 巴西站页面。

Chrome 助手 v0.5.4 增加了 Shopee 页面状态提示和“打开 Shopee 巴西首页”按钮。遇到页面不可用、人工验证、HTTP 403 或 429 时，助手暂停采集。等能手动打开正常的商品列表后，再从插件里开始或继续。

Chrome 助手 v0.5.5 支持在 Shopee 的 Popular 分类页显示本页识别和入库数量。保存失败可在弹窗中重试。需要批量采集时，可以切到「Mais Recente」或打开商品搜索结果。

已经安装本地平台时，可以单独更新 Chrome 助手。下载 GitHub 源码 ZIP 并解压，将其中的 `chrome_extension` 文件替换到原扩展目录，在 `chrome://extensions` 里点“重新加载”，然后重开 Shopee 标签页。商品、图片和备注保存在本地平台的 `data` 文件夹里。

## 后续接口

采集连接器采用独立适配器：Shopee 与 SHEIN 共用 Chrome 采集助手，Mercado Livre 后续优先接官方 API/公开数据连接器。网站接口改变时只替换连接器，不修改商品库与任务中心。

