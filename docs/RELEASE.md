# 发布约定（版本号 / tag / 资产命名）

给 agent 看的：这一页是**硬规则**，不是风格偏好。每条都对应代码里的一个约束，
违反的后果写在「违反会怎样」里。

## 0. 版本线（2026-11-19 起）

| 版本 | 定位 | 里面有什么 |
|---|---|---|
| **1.7.x** | **品牌过渡版** | 展示层全面换成 Orbis（`orbis.exe`、`orbis-*` 资产、安装器 Orbis、
|  |  | 窗口/UI 文案）；系统身份与协议头**保留旧值兼容**，见下面的 `@remove-2.0` |
| **1.7.1** | **弃用告警版**（已发布 2026-11-20） | 过渡版收官：命中旧 env（`PI_BOT_*`）/ 旧数据目录 / 旧请求头时打**去重告警**，
|  |  | 旧头请求回 `x-orbis-deprecated`；**App 改发 `x-orbis-*`**（1.7.0 服务端本就双读，向前兼容） |
| **2.0.0** | **收尾版** | 把 `@remove-2.0` 标记的兼容层一次性删掉：旧数据目录回退、
|  |  | `PI_BOT_*` 环境变量、`x-pi-bot-*` 请求头 |

> 2.0 的**阶段划分、三条主线（清债 / 基座化 / SIM-Lite 自进化）、验收门禁与新版本线**
> 见 [`docs/ROADMAP-2.0.md`](ROADMAP-2.0.md)。本页只定「版本号与资产命名」的硬规则。

**2.0 之前不要删兼容层** —— 1.7 发布时所有已装用户的数据目录还叫 `pi-bot`，
删了等于让他们的聊天记录“消失”（文件还在，但程序不看了）。

**升级路径**：`1.7.0 → 1.7.1 → 2.0.0`。跳版直接上 2.0 会出现「1.7.0 客户端还在发旧头 →
首个请求 403」，1.7.1 就是为了提前把这一步走完（App 先改发 `x-orbis-*`）。

清理时一条命令列出全部待删点：

```bash
grep -rn "@remove-2.0" server/src app/lib
```

哪些**永远不删**（系统身份，改了就是换新应用）：

| 标识 | 值 | 为什么不动 |
|---|---|---|
| Android `APP_ID` | `com.pibot.pi_bot` | 改了手机装不上更新，必须卸载重装（聊天数据在应用私有目录） |
| macOS `PRODUCT_BUNDLE_IDENTIFIER` | `io.pibot.piBot` | 改了等于新应用：权限、钥匙串、偏好全部重来 |
| Inno `AppId` GUID | `{7A31C4E8-...}` | 升级替换旧安装靠它；改了会并列装两份 |

## 一句话

**版本号只有一个，纯 semver。平台只出现在资产文件名里，绝不出现在 tag 里。**

预发布（`2.0.0-alpha.1` / `2.0.0-beta.2` / `2.0.0-rc.1`）是**合法**的 semver，
但**必须勾 Pre-release**（见 §2.1），且**不能带平台/日期后缀**。

## 1. tag 必须是纯 semver `vX.Y.Z`

```
✅ v1.3.0
✅ v2.0.0-alpha.1        ← 预发布，必须同时勾 Pre-release
❌ v1.3.0-win.20261022
❌ v1.3.0-macos
```

**为什么**：`server/src/update-check.js` 按 semver 解析 tag，`-` 之后算**预发布**，
而预发布**小于**同版本正式版（`compareVersions` 里 `if (!pb.pre.length) return -1`）：

| 远端 tag | 当前版本 | 内置更新检查的结论 |
|---|---|---|
| `v1.2.1` | `1.2.0` | ✅ 提示更新 |
| `v1.2.0-win.20261022` | `1.2.0` | ❌ 「远端版本比当前旧」→ 不提示 |
| `v1.2.1-win.20261022` | `1.2.1` | ❌ 「远端版本比当前旧」→ 不提示 |

**违反会怎样**：这个版本对所有已装用户**永久不可见**，更新提示形同虚设。

> 历史遗留：`v1.2.0-macos.20261021` 就是这种 tag。不用回改 —— 它同时勾了
> Pre-release，而 `/releases/latest` 不返回预发布，所以它既拿不到更新、也不会污染别人。

## 2. 发布必须勾普通 Release，不能勾 Pre-release

更新检查走 GitHub 的 `/releases/latest`，该接口**不返回** Pre-release 和 Draft。

**违反会怎样**：勾错了 → 这个版本对所有用户不可见（和上一条同样的后果）。

### 2.1 预发布（alpha / beta / rc）反过来：**必须勾** Pre-release

`2.0.0-alpha.1` 这类版本**只能**以 Pre-release 形式发布：

| 场景 | 勾 Pre-release | 后果 |
|---|---|---|
| alpha / beta / rc | ✅ 必须 | 1.7.1 稳定版用户不会被 `/releases/latest` 推上 alpha |
| 正式版 GA | ❌ 不能 | 否则所有人都收不到更新（§2） |

**为什么不靠版本号自己拦住**：`/releases/latest` **不返回**预发布，所以只要勾对，
1.7.1 用户根本看不到 alpha；而 alpha 用户自己想升级到正式版时，
`releases.atom` 那条路会跳过带 `-` 的 tag，等 `2.0.0` 正式版发出来就会提示。

**beta.1 起兼容层已按 Phase 3 分刀删除**（旧头 / 旧别名 / 旧 env 前缀 / 旧目录回退）——
真正删兼容层是 Phase 3 / `2.0.0-rc.1` 之后的事，见 `docs/ROADMAP-2.0.md` §3。

## 3. 版本号唯一真源是 `server/package.json`

`app/pubspec.yaml` 的 `version:` 必须与它一致（`+N` 是构建号，只增不减）：

```
server/package.json    "version": "2.0.0-alpha.1"
app/pubspec.yaml       version: 2.0.0-alpha.1+24
```

读取方：`server/src/version.js`（`/health`、ws hello、serverInfo 都用它）、
`scripts/pack-windows.ps1`、`scripts/pack-macos.sh`（产物名取自它）。

**`server/tests/version.mjs` 会断言两者一致** —— 只 bump 一处，`node tests/all.mjs` 会红。

## 4. 资产命名：`orbis-<平台>-v<版本>.<扩展名>`

```
orbis-windows-v1.3.0-setup.exe   ← Windows 一键安装（推荐给普通用户）
orbis-windows-v1.3.0.zip         ← Windows 免安装（要解压自己运行）
orbis-macos-v1.3.0.dmg
orbis-android-v1.3.0.apk
```

平台词**两侧必须有分隔符**。`server/src/update-check.js` 的 `PLATFORM_RULES` 用的是
`[-_. ]win[-_. ]` 这种带边界的匹配 —— 因为无锚点的 `/win/` 会命中 `darwin`，
把 Mac 包推给 Windows 用户。

**不要把 `.zip` 当万能兜底**：zip 判不出平台，`pickAssetFor()` 返回 `null`，
App 只能退化成「打开发布页」。

**同时挂 setup.exe 和 zip 时**：`PLATFORM_RULES` 里 `.exe` 排在平台词之前，
`pickAssetFor()` 按规则序号取最优，所以选中的一定是安装包，跟上传顺序无关。
这条有回归测试（`server/tests/update-check.mjs` 里的「同时挂安装包和免安装 zip」）。

## 5. 多平台可以增量挂到同一个 release

各平台构建时间不同，不必等齐：

```bash
gh release upload v1.3.0 dist/orbis-windows-v1.3.0.zip --clobber
```

找不到本平台资产的客户端会自动退到发布页（`UpdateInfo.canDownload == false`），
不会崩、也不会装错包。

## 6. 提交身份只用 noreply 邮箱

仓库是公开的，**每个提交的作者 / 提交者邮箱任何人都能看到**，而且进了历史就删不掉。

```bash
# 每台开发机、每个 agent 环境都要设（地址在 GitHub 设置 → Emails 里看）
git config --global user.email "<id>+<账号>@users.noreply.github.com"
```

**违反会怎样**：macOS 没配邮箱时 git 会自动用 `用户名@主机名.local`，把本机主机名公开；
用 QQ 邮箱等于公开 QQ 号。两种都发生过（2026-10），只能改写整个历史、强推全部分支和 tag 来清。

CI 的 secret scan 会拦：PR 扫 PR 里的提交（`--meta`），直接 push 到 main 扫新推的提交（`--push`）。
但 CI 是在**推上去之后**才跑的 —— 拦下来时地址已经公开了，所以提交前自己先跑一遍：

```bash
node scripts/check-secrets.mjs --push origin/main HEAD
```

## 发布清单

```bash
# 1. 在 main 上确认工作区干净、测试全绿
cd server && node tests/all.mjs
cd ../app && flutter analyze && flutter test

# 2. bump 版本（两处必须一致）
#    server/package.json  +  app/pubspec.yaml

# 3. 提交 + 打 tag + 推
git commit -am "chore(release): 2.0.0-alpha.1"
git tag v2.0.0-alpha.1
git push origin main v2.0.0-alpha.1

# 4. 各平台构建（从 tag 对应的提交构建，不要从半路的分支）
powershell -File scripts/pack-windows.ps1 -WithNode -Zip   # dist/orbis-windows{,.zip}
powershell -File scripts/pack-windows-setup.ps1            # dist/orbis-windows-v<版本>-setup.exe
./scripts/pack-macos.sh                                    # dist/orbis-macos-v<版本>.dmg
node scripts/pack-android.mjs                              # dist/orbis-android-v<版本>.apk

# 5. 建 release（alpha/beta/rc → ★必须勾 --prerelease；正式版 → ★绝不勾）
gh release create v2.0.0-alpha.1 --prerelease --title "Orbis v2.0.0-alpha.1" \
  --notes-file <说明> \
  dist/orbis-windows-v2.0.0-alpha.1-setup.exe dist/orbis-windows-v2.0.0-alpha.1.zip \
  dist/orbis-macos-v2.0.0-alpha.1.dmg dist/orbis-android-v2.0.0-alpha.1.apk
```

### npm 包（`orbis-agent`，T2.6）

SDK 是**另一个发布物**：桌面/安卓的安装包和 npm 包可以各自发布，但版本号同源
（都是 `server/package.json`）。发之前跑这三条：

```bash
# 随包分发的依赖里有 GPL/AGPL 就是事故。它读的是 server/node_modules 与
# app/.dart_tool/package_config.json，所以**必须先**两边的依赖都装好：
cd server && npm install && cd ../app && flutter pub get && cd ..
node scripts/check-licenses.mjs --check

cd server
npm run check:pack           # files 白名单 / 体积上限 / exports.types 指向
npm run check:pack-install   # 空目录 npm i <tgz>，再跑一遍 examples/sdk/01
npm publish --tag alpha      # 预发布一律用 dist-tag，不要抢 latest（稳定版仍是 1.7.1）
```

要点：

- `prepack` 会自动重建 `types/`、复制 `LICENSE` 与 `docs/SDK.md` —— 这三个都不入库；
- `files` 白名单是**白名单**，新加的运行时目录（比如新的子包）要显式加，否则装出来少文件；
- 许可证检查**不进 CI**：它依赖 `app/.dart_tool/package_config.json`（要 `flutter pub get`），
  放进任一 CI job 都会因为"装不全"误报上百个未知组件 —— 它是发布前的人工步骤；
- `exports` 每一项都必须带 `types`，否则 IDE 里拿不到类型；`./package.json` 必须可达；
- 体积上限写在 `scripts/check-pack.mjs`（解包 12MB / 压缩 4MB）。要调大先说清
  “这次多出来的是什么”，别直接改数字。

### `v2.0.0-beta.1` 发版清单（2026-11-22 起）

> 与 alpha.1 的差别只有一条：**多一个 npm 包的 tgz 产物**。
> ⚠️ **暂不推 npmjs.org**（ROADMAP §7 D5：2.0 先走 tarball / 私有验证，2.1 再公开）。
> 所以这一步没有 `npm publish`，只有 `npm pack` + 把 tgz 挂到 Pre-release 上。

```bash
# 0. 版本号已 bump（两处必须一致，且都过 version.mjs 的正则）
#    server/package.json → 2.0.0-beta.1
#    app/pubspec.yaml    → 2.0.0-beta.1+25

# 1. 五守卫 + 全量测试
cd server && node tests/all.mjs            # 期望 173/173
cd .. && node scripts/check-style.mjs && node scripts/check-legacy.mjs   && node scripts/check-spec-progress.mjs && node scripts/check-secrets.mjs
cd server && node scripts/check-consistency.mjs && node scripts/check-capability-drift.mjs

# 2. SDK 侧门禁（需要 devDependencies）
npm install && npm run types && npm run check:types && node tests/sdk-examples.mjs

# 3. 许可证（要 app 的 package_config，先 flutter pub get）
cd ../app && flutter pub get && cd ..
node scripts/check-licenses.mjs --check

# 4. 发布包体检 + 干净容器验收
cd server && npm run check:pack && npm run check:pack-install

# 5. 打出要交付的 tgz（★ 不是 npm publish）
npm pack                      # → orbis-agent-2.0.0-beta.1.tgz
shasum -a 256 orbis-agent-2.0.0-beta.1.tgz   # Windows: certutil -hashfile ... SHA256

# 6. 提交 + 打 tag + 推（tag 必须是纯 semver）
git commit -am "chore(release): 2.0.0-beta.1"
git tag v2.0.0-beta.1
git push origin main v2.0.0-beta.1

# 7. 平台产物（从 tag 对应的提交构建）
powershell -File scripts/pack-windows.ps1 -WithNode -Zip   # setup.exe + zip
node scripts/pack-android.mjs                              # apk
# macOS DMG 在 Mac 上、同一个 tag commit 上补：
#   ./scripts/pack-macos.sh

# 8. Pre-release（alpha/beta/rc → ★必须勾 --prerelease）
gh release create v2.0.0-beta.1 --prerelease --title "Orbis v2.0.0-beta.1"   --notes-file <说明>   orbis-windows-v2.0.0-beta.1-setup.exe orbis-windows-v2.0.0-beta.1.zip   orbis-android-v2.0.0-beta.1.apk orbis-agent-2.0.0-beta.1.tgz
#   DMG 等 Mac 端补齐后增量挂到同一个 release（见下面 §5 多平台增量）
```

alpha.1 的教训（这次照做）：

- **tgz 必须在干净 clone 上打**：`prepack` 负责重建 `types/` 并复制 `LICENSE` / `docs/SDK.md`，
  少一步打出来就缺文件（`check:pack-install` 会先删盘上副本再测，就是为了抓这个）；
- **tgz 不进 git**：`server/*.tgz` 已在 `.gitignore` 里，交付走 release 附件；
- **tag 与 commit 的对应关系要写进 release notes**，否则 mac 端补 DMG 时不知道从哪构建；
- **发版前复核公告**（ROADMAP T1.9 的验收项）：§2.0 的破坏性变更表 / 常见问答 / 回滚步骤
  必须与本次真正删掉的东西逐条对得上 —— 公告写错比不写更糟，用户会照着错的指引回滚。

### `v2.0.0-rc.1` → `v2.0.0` GA 清单（本轮审完后的统一合栈）

> rc.1 是**预发布**（`--prerelease`）：先把整条栈合进 `main`、切 rc.1、跑真机验收；
> 验收全绿后才切 GA。rc.1 与 GA 的**代码相同**，差的是真机结论。

```bash
# 0. 合栈（顺序不能变：栈底 → 栈顶，每个 PR 都是 Draft，逐个 Ready + merge）
#    #39 long-task-autonomy → #40 perf-v1 → #41 cluster-parallel → #42 perf-failfast
#    → #43 task-guardrails → #44 desktop-win-stage-b → 本分支 pre-rc1-polish
gh pr ready 39 && gh pr merge 39 --merge && ...（逐个）

# 1. 版本号（唯一真源，两处必须一致）
#    server/package.json → 2.0.0-rc.1
#    app/pubspec.yaml    → 2.0.0-rc.1+NN
node scripts/check-consistency.mjs

# 2. 全量门禁（rc.1 与 GA 各跑一次，结果贴进 release notes）
cd server && node tests/all.mjs            # 期望 200/200
cargo test --release --manifest-path ../native/orbis-desktop-win/Cargo.toml   # 期望 29/29
cd .. && node scripts/check-style.mjs && node scripts/check-legacy.mjs --strict   && node scripts/check-spec-progress.mjs && node scripts/check-secrets.mjs   && node scripts/check-licenses.mjs --check
cd server && node scripts/check-consistency.mjs && node scripts/check-capability-drift.mjs
cd ../app && flutter analyze && flutter test        # 期望 1059 通过 / 3 跳过

# 3. 原生助手产物（阶段 B：常驻 serve + 原生截图）
powershell -File scripts/build-desktop-win.ps1          # → resources/orbis-desktop-win.exe + .sha256
powershell -File scripts/build-desktop-win.ps1 -Check   # 必须**秒退** OK（version 不再等 stdin）
cd server && node tests/perf-stall.mjs --impl=native    # 指标写进 release notes
node tools/desktop-parity.mjs                           # 必须「口径一致 ✅ / 0px」

# 4. 真机验收门禁（**rc.1 必须全绿才允许切 GA**）
#    docs/REAL-MACHINE-CHECKLIST.md → 4b 进程清理 / 4c 阶段 A / 4d 阶段 B
#    重点三项：① 停机后无 orbis-desktop-win.exe 残留；② 连点连截 200 次 GDI 对象回到基线；
#             ③ 多显示器负原点全屏截图区域正确
#    另：#43 的 T6 护栏在真机上跑一次 401（应 1 次即停，不空转 3 轮）

# 5. rc.1 发布（预发布）
git tag v2.0.0-rc.1 && git push origin main v2.0.0-rc.1
powershell -File scripts/pack-windows.ps1 -WithNode -Zip
node scripts/pack-android.mjs
cd server && npm pack                                   # orbis-agent-2.0.0-rc.1.tgz
gh release create v2.0.0-rc.1 --prerelease --title "Orbis v2.0.0-rc.1" --notes-file <说明> ...

# 6. GA（真机全绿之后，代码不再改，只切版本 + tag）
#    server/package.json → 2.0.0 ; app/pubspec.yaml → 2.0.0+NN
#    重复 2–5（不带 --prerelease），并勾选 "Set as the latest release"
```

rc.1 → GA 之间**只允许**改版本号与 release notes；任何代码改动都要回到分支重新审。

### 2.0 的破坏性变更（相对 1.7）

> **升级路径：1.4 / 1.7 → 先升 1.7.1 → 再升 2.0。**
> 1.7.1 是这次过渡的「垫片」：App 开始发 `x-orbis-*`、服务端开始对旧 env / 旧目录 /
> 旧请求头打去重告警。跳过它直接上 2.0，会同时踩「请求头失效 + 环境变量读不到」两件事；
> 旧数据目录则靠 2.0 自带的 `orbis migrate` 搬（见下节，**不是**在 1.7.1 上搬）。

| 变了什么 | 1.7 还能用吗 | 2.0 怎么办 |
|---|---|---|
| 旧数据目录回退 | ✅ | ❌ **已删**：2.0 只认新目录；旧目录有数据时启动会在日志里给出 `orbis migrate` 指引（`/health` 的 `needsMigration=true`）。**升级后先跑迁移再让用户用**，见下节 |
| 全部 `PI_BOT_*` 环境变量 | ✅ | ❌ **已删**：只认 `ORBIS_*`（桌面端 1.7.0 起传的就是新名）。启动脚本 / systemd / 容器 env 要先改名 |
| `PI_BOT_SECRET_KEY` | ✅ | ❌ **已删**：只认 `ORBIS_SECRET_KEY` |
| 请求头 `x-pi-bot-client` / `-nonce` / `-channel` | ✅ | ❌ **已删**：只认 `x-orbis-*`，缺头 403 并提示正式头名。**App 必须是 1.7.1 及以上** |
| SDK 别名 `createPiBotRuntime` / `createPiBotClient` / `PiBotClient` | ✅ | ❌ **已删**：改成 `createOrbisRuntime` / `createOrbisClient` / `OrbisClient`（签名一致） |
| `bin.pi-bot-server` | ✅ | ❌ **已删**：`npm exec orbis-server`（1.7.1 起就有了） |
| 沙箱启动器 `pibot-sandbox.exe` | ✅ | ⚠️ 改名 `orbis-sandbox.exe`：2.0 只找新名字；旧 env `PIBOT_SANDBOX_EXE` / `PIBOT_GIT_PATH` 还能读**一个周期**（命中会在日志里提醒一次，2.1 删除） |
| `pi-bot.config.json` | ✅ | ⚠️ 仍能读（提醒一次）；新名字是 `orbis.config.json`（`orbis migrate` 会复制一份） |
| 发现协议（UDP 双播） | ✅ | ✅ **永久双播**：服务端同时回应 `orbis.host` 与 `pibot.host`，App 两边都发都认 |
| TLS 证书 | ✅ | ✅ 新证书 SAN 增加 `orbis.local`，旧 `pi-bot.local` 与 CN `pi-bot` 保留（不改证书身份 = 不重配对） |

### 1.4 / 1.7 → 2.0 的平滑路径

**1) 先升到 1.7.1**（只打补丁：不动数据、不改证书）。装完启动一次，让它把命中的
旧 env / 旧数据目录 / 旧请求头写进日志 —— 那一串弃用提醒就是你的「2.0 待办清单」，
按它把启动脚本里的 `PI_BOT_*` 改成 `ORBIS_*`（1.7.1 两种名字都认），并确认手机 App 到了 1.7.1。

**2) 再装 2.0。** `orbis migrate` 从 `2.0.0-rc.1` 起才有 —— 1.7.1 上没有这个命令，
所以迁移只能在新版本上做。2.0 首次启动会发现旧目录有数据但新目录没有：**它不建空库**，
只在日志里给出两条真实路径 + 一条可复制执行的命令，并给 `/health` 落一个
`needsMigration=true`。

**3) 按提示迁移，再重启。**

```bash
orbis migrate --dry-run   # 只报告会搬什么，不写盘
orbis migrate             # 只复制、不删除
# 重启服务端；/health 的 needsMigration 变 false 就完成了
```

跳过 1.7.1 直接装 2.0 也能起来，但要自己记得跑迁移；否则界面是空的
（旧数据还在原处，只是 2.0 不认那个目录）。

### `orbis migrate` 的细节

2.0 起服务端**只认新目录**（`<数据根>/orbis/data`）。命令本身只有三步
（`--dry-run` 看一遍 → `orbis migrate` → 重启，报告在
`<数据根>/orbis/data/migration-report.json`）。

**桌面端（Windows 安装包 / macOS `.app`）不要手敲命令**：安装包里没有把 `orbis`
放进 `PATH`，`orbis.exe` 也是 GUI 入口、不认 CLI 参数。2.0 的迁移门禁页上有一个
**「一键迁移并重启」**按钮，它会用发行包里自带的 node 跑
`server/src/index.js migrate --from … --to …`，跑完自动重启成迁移后的 2.0。
门禁页同时把这条**真实可执行**的完整命令露出来（可复制），纯 CLI / npm 安装的
用户可以直接 `orbis migrate`。

容易踩的是下面几条：

- **先起过一次 2.0 也没关系**：2.0 的待迁移模式不会建密钥/证书，但如果你之前用的是
  beta 版（它当时会建），迁移会把那套 `secret.key` / `tls/` / 空 `state.json` 挪到
  `<新目录>/.pre-migrate-<时间>/`，再把 1.7 的原件复制进来 —— **密钥与证书指纹保持不变**；
- **旧目录不会被删除**；但注意下面那条 `workspace`：旧工作目录还在被 2.0 使用时，
  旧目录就**不能删**；
- 重复执行是幂等的（第二次直接报「已经迁移过」）；
- 新目录里已经有用户数据时会拒绝执行 —— 确实要补齐缺的文件加 `--force`，它**只补缺失、永不覆盖**；
- `workspace` 不复制（里面常有几百 MB 的 .venv / node_modules，且绝对路径复制过去就坏），
  迁移报告里会记下旧工作目录，服务端继续用它 —— **命令结束时会明确提示「请勿删除旧目录」，
  那时删了等于删掉整个工作目录**；
- 自定义安装位置可以用 `--from <旧> --to <新>`；脚本里用 `--json` 拿结果。

### 常见问答

**Q：手机还是老版本 App（1.7.0 或更早），能连 2.0 服务端吗？**

能发现、能配对、能看历史，**不能发消息**：

- 发现走 UDP 永久双播，`pibot.discover` 照样有应答；
- 配对走 `POST /api/pair`，那个接口本来就不要求 `x-orbis-client`（配对码本身就是凭证）；
- 但发消息 / 改设置是写请求，2.0 只认 `x-orbis-*`，1.7.0 的 App 发的是旧头 → 403，
  报错里会写明该带哪个头。**升到 1.7.1 或更新的 App 就恢复正常。**

**Q：升级后界面是空的，数据去哪了？**

在旧目录里，2.0 只是不认它。跑 `orbis migrate` 复制过来再重启；`/health` 的
`needsMigration` 为 true 就是在提醒这件事。

**Q：我的启动脚本里有 `PI_BOT_HOME` / `PI_BOT_TOKEN`，会怎样？**

2.0 读不到它们 —— 服务端会用默认目录、App 会当没填 token。改成 `ORBIS_HOME` / `ORBIS_TOKEN`
即可（1.7.1 起两种名字都能用，正好在旧版本上先改）。

**Q：证书会不会重签？配对要不要重做？**

不会。2.0 不改证书身份（CN 仍是 `pi-bot`、旧 SAN `pi-bot.local` 保留，只新增 `orbis.local`），
已配对的设备继续按原指纹认这台机器。

**Q：自己编译的 Windows 沙箱启动器呢？**

用 `scripts/build-sandbox-win.ps1` 重新生成，产物已经是 `orbis-sandbox.exe`；
`PIBOT_SANDBOX_EXE` 还能指一个周期，命中时日志里会提醒改名。

### 回滚到 1.7（零数据损失）

`orbis migrate` **只复制不删除**，1.7 的数据目录原样还在，所以回滚就是「装回 1.7.1 + 不碰新目录」：

1. 停掉 2.0 服务端；
2. 装回 1.7.1（安装器的 AppId 不变，只替换安装目录；用户数据不在安装目录里，不受影响）。
   Windows 安装器会先按 `server.pid` 停掉在跑的 `node.exe`，2.0 的 `orbis` 与 1.7 的 `pi-bot`
   两个数据目录都会看 —— 否则 node.exe 锁着安装目录，[Files] 拷贝会失败；
3. 1.7.1 从 `<数据根>/pi-bot/data` 启动，看到的是**升级前**的数据。

⚠️ 这里说的是「不丢数据」，不是「带上新数据」：2.0 期间产生的消息写在 `<数据根>/orbis/data`，
回滚后 1.7 读不到。要它也要，就手工把 `state.json`（以及附件目录）从新目录复制回旧目录，
或者干脆回到 2.0 —— 两个目录互不覆盖，来回切换永远不删东西。

### 预发布版的三个“不能用完整版本号”的地方

完整版本（`2.0.0-alpha.1`）只用在：tag / 资产名 / 服务端 API 返回 / 界面展示。
下面三处**必须是纯数字**，否则编译/签名/安装会直接失败，脚本已自动处理，改脚本时别改回去：

| 位置 | 要求 | 谁在算 |
|---|---|---|
| Windows PE 版本资源（`VersionInfoVersion`） | `A.B.C.D` | `pack-windows-setup.ps1` 传 `/DAppFileVersion=<X.Y.Z>.0` |
| macOS `CFBundleShortVersionString` | `X.Y.Z` | `pack-macos.sh` 传 `flutter build macos --build-name=<X.Y.Z> --build-number=<N>` |
| Android `versionCode` | 整数 | `pubspec.yaml` 的 `+N` |

## 平台差异不要写进版本号

同一个版本号 = 同一份代码 = 同一套服务端。平台差异只体现在**构建产物**和
`docs/WINDOWS.md` / `docs/MACOS.md` 的验收记录里。

如果两个平台各自需要独立的版本号，说明**代码又分叉了** —— 那是
[平台边界与共享规则](PLATFORMS.md) 要解决的问题，不是靠 tag 后缀掩盖的。
