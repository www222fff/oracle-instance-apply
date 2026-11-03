# oracle-instance-apply

定时用一个已登录 Oracle Cloud 的 CDP Chrome，在 Resource Manager 里对已有 Stack 点 Apply，抢 Always Free 实例（如 ARM A1.Flex）。只在成功或需要人工处理时输出通知，`Out of capacity` 静默重试。

## 工作方式

- 每轮对每个未完成的 Stack：打开 Stack 页 → Actions → Apply → 确认，然后最多等 12 分钟看 Job 结果。
- Job 还没结束就记下 `lastJobUrl`，下一轮先查这个 Job，不重复提交。
- 结果处理：
  - `Out of capacity` / `Out of host capacity`：静默，累加 `capacityFailures`。
  - `Succeeded`：输出成功通知，该 Stack 标记 `done`，以后跳过。
  - 超出配额 / 限额：输出通知并标记 `done`。
  - 其他失败、登录失效：输出通知，同一类 6 小时内只发一次。
- 通知内容夹在 `OCI_FREE_REPORT_BEGIN` / `OCI_FREE_REPORT_END` 之间；`run.sh` 只把这部分打印到 stdout，方便交给 cron / 机器人直接转发。

## 文件

| 文件 | 作用 |
| --- | --- |
| `oci-apply-stack.js` | 主逻辑（Puppeteer） |
| `run.sh` | 定时任务入口：加锁、跑一轮、只输出报告块 |
| `oci-upload-stack.js` | 自动 Edit stack 上传新的 Terraform zip |
| `make-stack-zip.sh` | 把 Terraform 目录打成 zip |
| `terraform/main.tf` | A1 实例 Stack 模板（可用域轮换、公网 IP） |
| `config.example.json` / `local.env.example` | 本地配置示例 |

本地文件 `config.json`、`local.env`、`local/`、`dist/`、`state.json` 都被 git 忽略，个人的 OCID、路径等只放在这些文件里。

## 安装

```bash
npm install
cp config.example.json config.json   # 填 Stack OCID、region、cdpUrl
cp local.env.example local.env       # 可选
```

`config.json` 字段：

- `cdpUrl`：开着远程调试的 Chrome，例如 `http://127.0.0.1:9222`。这个 Chrome 里要已经登录 `cloud.oracle.com`。
- `stateFile`：状态文件路径（相对仓库目录），默认 `state.json`。
- `chromeHelper`：可选，一个导出 `ensureWindowsChrome(startUrl)`（和可选的 `forceNoProxyEnv()`）的模块路径，用来按需拉起 Chrome；不填就只检查 `cdpUrl` 能不能连上。
- `stacks`：`[{ label, name, ocid, region }]`。

定时运行（例子，每 30 分钟）：

```cron
*/30 * * * * /path/to/oracle-instance-apply/run.sh
```

## Terraform 模板

`terraform/main.tf` 是从控制台“创建实例 → Save as stack”导出的配置改出来的：

- 可用域不写死：按 Apply 时的 UTC 时间每 30 分钟一个槽位，`(小时*2 + 分钟/30) % AD 数` 轮换。实例上 `ignore_changes = [availability_domain]`，建好后再 Apply 不会重建。
- `assign_public_ip = "true"`，实例创建后有公网 IP。
- `compartment_ocid`、`tenancy_ocid` 由 Resource Manager 自动注入；`image_ocid` 需要在 Stack 变量里填。
- 如果 Apply 报 `CIDR ... overlaps`，说明 VCN 里已有同网段子网但不在 state 里。按文件里注释打开 `import` 块填现有子网 OCID，并让子网的 `display_name` / `dns_label` 与现有子网一致。

上传到已有 Stack：

```bash
./make-stack-zip.sh                       # local/ 存在时用 local/，否则用 terraform/
node oci-upload-stack.js <stack-ocid> <region> <Chrome 能访问的 zip 路径>
```

上传后建议在控制台对 Stack 跑一次 Plan，确认只有 `1 to add`（以及可能的 `1 to import`），没有 destroy。

## 控制台注意点

- 后台标签页里 OCI 控制台的 iframe 不渲染正文，脚本会 `bringToFront()`。
- Stack / Job 页面会先渲染旧版界面再切到新版，脚本等新版 "General information" 出现并稳定后才点。
- 新版 Job 页状态显示为 job 名下的徽章（`apply-job-…` / `Failed` / `Job`）。
- 日志是滚动加载的，读 Error 前要滚到底。
- 关掉 Chrome 的最后一个标签页会让 Chrome 退出，脚本只剩一个标签时改为停在空白页。
- 想让重启 Chrome 后保持登录：对 `[*.]oracle.com`、`[*.]oraclecloud.com` 加 Cookie 允许例外，并打开“启动时继续上次浏览”。Identity Domain 的 Session duration 可以调到 32767 分钟。
