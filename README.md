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
  - 控制台页面类的临时错误（frame detached、没跳到 job 页、页面没加载出来等）：连续 3 轮才通知，中间任意一轮正常就清零。
- 在最终确认 Apply 之前，任何一步失败都会刷新页面重试（最多 3 次），不会重复提交。调试时设 `OCI_APPLY_DEBUG=1` 打印完整堆栈。
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

定时运行（例子，每 5 分钟）：

```cron
*/5 * * * * /path/to/oracle-instance-apply/run.sh
```

## Terraform 模板

`terraform/main.tf` 是从控制台“创建实例 → Save as stack”导出的配置改出来的：

- 可用域不写死：按 Apply 时的 UTC 时间每 `ad_rotate_minutes`（默认 5）分钟一个槽位，`floor((小时*60 + 分钟) / ad_rotate_minutes) % AD 数` 轮换，和定时间隔一致时每轮换一个可用域。实例上 `ignore_changes = [availability_domain]`，建好后再 Apply 不会重建。
- `assign_public_ip = "true"`，实例创建后有公网 IP。
- `compartment_ocid`、`tenancy_ocid` 由 Resource Manager 自动注入；`image_ocid` 和 `ssh_public_key` 需要在 Stack 变量里填。
- `ssh_public_key` 一定要在抢到之前填好：公钥只在实例第一次开机时写入，事后改 Stack 不会生效，镜像默认也没有密码。
- 如果 Apply 报 `CIDR ... overlaps`，说明 VCN 里已有同网段子网但不在 state 里。按文件里注释打开 `import` 块填现有子网 OCID，并让子网的 `display_name` / `dns_label` 与现有子网一致。

上传到已有 Stack：

```bash
./make-stack-zip.sh                       # local/ 存在时用 local/，否则用 terraform/
node oci-upload-stack.js <stack-ocid> <region> <Chrome 能访问的 zip 路径>
```

上传后建议在控制台对 Stack 跑一次 Plan，确认只有 `1 to add`（以及可能的 `1 to import`），没有 destroy。

## 从零开始的完整步骤

下面是实际搭起来时走过的流程，按顺序做即可。

### 1. 准备 Stack

1. 在 Oracle Cloud 控制台走一遍“创建实例”（选 `VM.Standard.A1.Flex` 等 Always Free 规格），最后不要点 Create，点 **Save as stack**，得到一个 Resource Manager Stack。
2. 打开这个 Stack → Details → Terraform configuration → **Download**，拿到它的 zip，解压出 `main.tf`。
3. 在 Stack 的 **Jobs** 里看历史 Apply 的日志。如果报 `The requested CIDR ... overlaps`，说明 VCN 里已经有同网段子网但不在 Terraform state 里，每次 Apply 都会卡在建子网，根本走不到创建实例。

### 2. 改 Terraform 配置

以 `terraform/main.tf` 为模板，把导出的 `main.tf` 改成：

1. 可用域改成按时间轮换（`data "oci_identity_availability_domains"` + `locals`），实例加 `lifecycle { ignore_changes = [availability_domain] }`。
2. `create_vnic_details` 里 `assign_public_ip = "true"`，否则实例没有公网 IP。
3. 实例里加 `metadata = { ssh_authorized_keys = "<你的公钥>" }`，否则抢到也登不进去。公钥只写在 `local/main.tf` 里，不要提交。
4. 如果第 1 步看到 CIDR 重叠：加 `import` 块导入现有子网，并把子网的 `display_name`、`dns_label` 改成和现有子网完全一致（不一致会被判定为 forces replacement，Terraform 会删掉重建子网）。
5. 改好的个人版本放在 `local/main.tf`（已被 git 忽略）。

### 3. 上传并用 Plan 验证

1. `./make-stack-zip.sh local <Chrome 能访问的路径>/stack.zip`
2. `node oci-upload-stack.js <stack-ocid> <region> <同一个 zip 的路径>`：直接打开 `/stacks/<ocid>/edit?fromStack=1`，上传 zip，两次 Next，确认没勾 Run apply，Save changes。
3. 在控制台对 Stack 点 **Plan**，看日志里的汇总行。期望是 `Plan: 1 to import, 1 to add, 0 to change, 0 to destroy`（没有 import 时是 `1 to add`）。出现 `to destroy` 或 `must be replaced` 就回到第 2 步对齐属性。

### 4. 让 Chrome 保持登录

1. 用一个固定 profile 启动带 `--remote-debugging-port` 的 Chrome，在里面登录 `cloud.oracle.com`。
2. Chrome 设置 → 隐私 → Cookie：给 `[*.]oracle.com`、`[*.]oraclecloud.com` 加“始终允许”例外（如果同步设置里开了“退出时清除 Cookie”，不加例外重启就会掉登录）。
3. Chrome 设置 → 启动时 → **继续浏览上次打开的网页**，这样会话 Cookie 在重启后也能保留。
4. Oracle 控制台 → Identity & Security → Domains → Default → Settings → **Edit session settings**，把 Session duration 从默认 480 分钟改到 32767 分钟（约 22 天）。
5. 验证：正常关闭再打开 Chrome，打开 Stack 列表页，不跳登录页就算成功。

### 5. 配置并试跑

1. `cp config.example.json config.json`，填 `cdpUrl`、`stacks`；需要自动拉起 Chrome 时填 `chromeHelper`。
2. `cp local.env.example local.env`，按需设置锁文件（和其他操作同一个 Chrome 的任务共用一把锁）。
3. 手动跑一轮：`./run.sh`，再看 `OCI_APPLY_LAST_LOG`。期望看到 `已提交 Apply`，以及 `容量不足（Out of host capacity），下轮重试` 或成功。

### 6. 定时运行

1. 用 cron（或其他调度器）每 5 分钟执行一次 `run.sh`（一轮约 1.5–2 分钟，不建议再短；改间隔时同步改 `ad_rotate_minutes`），把它的 stdout 转发到通知渠道；stdout 为空时说明这一轮不需要通知。
2. 抢到后该 Stack 自动标记 `done` 不再 Apply，到 Compute → Instances 查看公网 IP。
3. 想加别的规格（比如 `VM.Standard.E2.1.Micro`），按第 1–3 步再做一个 Stack，追加到 `config.json` 的 `stacks`。

## 控制台注意点

- 后台标签页里 OCI 控制台的 iframe 不渲染正文，脚本会 `bringToFront()`。
- Stack / Job 页面会先渲染旧版界面再切到新版，脚本等新版 "General information" 出现并稳定后才点。
- 新版 Job 页状态显示为 job 名下的徽章（`apply-job-…` / `Failed` / `Job`）。
- 日志是滚动加载的，读 Error 前要滚到底。
- 关掉 Chrome 的最后一个标签页会让 Chrome 退出，脚本只剩一个标签时改为停在空白页。
- 想让重启 Chrome 后保持登录：对 `[*.]oracle.com`、`[*.]oraclecloud.com` 加 Cookie 允许例外，并打开“启动时继续上次浏览”。Identity Domain 的 Session duration 可以调到 32767 分钟。
