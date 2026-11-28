# LatAm Collector

面向巴西跨境电商选品的本地数据管理与采集平台。选品雷达为 Shopee 与 SHEIN 商品统一中文品类，支持分组筛选、匹配数量和手动改类。平台也支持商品和评论采集、销量与价格追踪、收藏和备注。

Chrome 采集助手可在正常浏览 Shopee / SHEIN 巴西站时整理支持的公开商品与评论响应，并发送到本机平台，不读取密码或请求头。

## Windows EXE 安装

1. [下载并运行 Windows x64 安装包](https://github.com/ihzzy630-crypto/LatAmCollector/releases/download/windows-v0.8.1/LatAmCollector-Setup-0.8.1-x64.exe)。安装包包含运行环境、选品雷达和 Chrome 采集助手。
2. 已安装过的用户选择原来的安装目录。安装器会识别 `D:\gpt专用文件\LatAmCollector`，每台电脑在各自安装目录的 `data` 文件夹存放商品库。
3. 双击桌面的 **LatAmCollector** 打开选品雷达。需要 Windows 登录时启动服务，可在安装过程中勾选自动启动。
4. 在 Chrome 按下文加载安装目录里的扩展文件夹。开始菜单的 **Chrome Helper Folder** 打开该目录。

## PowerShell 一键安装

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

已经安装本地平台时，运行新版安装包并选择原来的安装目录。重启本地平台后，左下角显示 v0.8.1。

首次启动会整理商品库里的旧品类，随后按平台品类和葡语标题为新商品归类。品类旁的数字按当前应用的筛选条件计算。可以在商品右侧点击“改品类”纠正自动结果，也可以随时恢复自动分类。

## 生成 EXE

双击 `build_windows.bat` 后，独立程序位于 `dist\LatAmCollector.exe`，离线模型位于 `dist\review_models`。运行时将两者放在同一目录，程序会在 EXE 旁创建 `data` 文件夹。

在安装了 Inno Setup 6 的 Windows 上，先运行 `python -m windows.prepare_review_models build/review_models`，再用 `ISCC.exe windows\LatAmCollector.iss` 生成安装器。GitHub Actions 会在 Windows 构建并验证安装器。

## 单品评论采集与中文翻译

1. 在装有 v0.8.1 采集助手的 Chrome 打开本地平台。从选品雷达进入某件商品的「查看评论」，点击「开始采集评论」。
2. 助手在后台打开原商品页，找到评论区并按页面提供的分页逐页入库。每次翻页前确认上一批已保存。可在单品页暂停或查看采集标签页。遇到登录、验证、限流、重复结果或不能确认下一页时会显示原因。
3. 点商品下方的「翻译成中文」，可翻译已入库的文字评论并查看进度。完整 Windows 安装包含离线模型，新采集的评论也会在本机翻译。译文与葡语原文并排显示，译文可随评论导出。
4. 「关键词气泡」显示提及条数，点击气泡可查看相关评论。悬停可查看葡语关键词和高、低星评论各有多少条提及。

本机使用 [Argos Translate 语言包](https://github.com/argosopentech/argospm-index)，以葡萄牙语、英语、简体中文依次转换。所用语言包来自 [OPUS-MT](https://aclanthology.org/2020.eamt-1.61/)（CC BY 4.0）。评论文本和译文保存在本机。

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
- 大图卡片和表格视图，支持按商品打开对应的评论洞察
- 评论评分分布、主题概览、原文，以及按年份、情绪、主题、媒体和关键词筛选
- SQLite 本地存储和重复数据更新
- 商品及评论 CSV/Excel 导出
- 任务配置、数据源状态和运行日志
- 只监听本机 `127.0.0.1`，不会对局域网或互联网开放管理端
- Chrome 自动采集助手（`chrome_extension` 文件夹）
- Shopee 当前分类或搜索列表一键翻页，按网站分页入库
- 批量任务进度、主动暂停与同一列表续采

## 安装 Chrome 采集助手

1. 在 Chrome 打开 `chrome://extensions`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 LatAmCollector 安装目录下的 `chrome_extension` 文件夹。
5. 保持本地平台运行，打开或刷新 Shopee / SHEIN 巴西站页面。

在 Shopee 巴西站的分类页或搜索结果页打开 Chrome 助手，点「自动翻页采集」。助手从原标签页的当前页开始，确认入库后操作下一页。保持该标签页和旁边的进度标签页运行。

「Shopee 子类和关键词批量采集」支持从已打开的巴西站页面读取分类链接、按组添加 160 个葡语搜索词，以及批量粘贴自定义词和 Shopee 列表链接。开启「自动加入列表中发现的子类」后，助手会把当前页面公开链接中可识别的下级分类追加到队列。

点「一键开始」后，队列在独立标签页按顺序采集，在本页商品确认入库后使用网页上的下一页按钮。每个入口最多采集设置的页数，也会在最后一页或重复页结束。保留队列页和本地平台运行。碰到验证、登录或访问受限时，点「查看采集页」手动处理，再点「继续采集」。

已经安装本地平台时，可以[单独下载新版 Chrome 助手](https://github.com/ihzzy630-crypto/LatAmCollector/releases/download/windows-v0.8.1/LatAmCollector-Chrome-v0.8.1.zip)。解压后，将其中的 `chrome_extension` 文件替换到原扩展目录，在 `chrome://extensions` 点「重新加载」，再刷新 Shopee 标签页。商品、图片和备注保存在本地平台的 `data` 文件夹里。

## 后续接口

采集连接器采用独立适配器：Shopee 与 SHEIN 共用 Chrome 采集助手，Mercado Livre 后续优先接官方 API/公开数据连接器。网站接口改变时只替换连接器，不修改商品库与任务中心。

