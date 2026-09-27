# 桌面应用

每个版本的 Release 都会附带 Electron 桌面应用构建产物，覆盖 macOS（Apple silicon 与 Intel）、Windows 和 Linux（x86_64 与 arm64）。

## 它是什么

桌面应用 = 一个 Electron 窗口 + 内置在同一个安装包里的网关服务。启动时主进程会拉起网关（与 Docker 镜像中运行的 Next.js standalone 服务完全相同），等 `/health` 通过后再打开控制台窗口。

- 网关只监听 `127.0.0.1`，不会暴露到局域网。
- 默认端口 `8001`；被占用时向上探测下一个空闲端口，也可以用 `CODEBUDDY_DESKTOP_PORT` 固定端口。
- 关闭窗口后（macOS）网关仍在后台运行，`/v1/*` 继续可用；退出应用才会停止网关。

## 数据存放位置

所有数据都写在 Electron 的 `userData` 目录里，而不是安装目录：

| 路径                     | 说明                                      |
| ------------------------ | ----------------------------------------- |
| `data/`                  | 文件存储目录，默认放置 `storage.sqlite`   |
| `credentials/`           | CodeBuddy 凭据文件                        |
| `storage-encryption-key` | 首次启动生成的存储加密密钥（权限 `0600`） |

桌面应用默认使用 `sqlite` 后端，并在首次启动时生成加密密钥，因此凭据和 API key 是加密存储的。**删除 `storage-encryption-key` 会导致已加密的数据无法解密**，这与自行部署时的契约一致，备份时请连数据库一起备份。

环境变量仍然生效：设置 `CODEBUDDY_STORAGE_BACKEND`、`DATABASE_URL` 或 `CODEBUDDY_STORAGE_ENCRYPTION_KEY` 后，桌面应用会按你的配置连接 PostgreSQL 或使用已有的密钥。

## 签名说明

构建产物未做代码签名。macOS 首次打开需要在「访达」中右键点击应用并选择「打开」；Windows 会提示 SmartScreen，选择「仍要运行」即可。

## 从源码构建

```bash
bun install
bun run build
bun run desktop:prepare   # 组装网关、打包主进程、按 Electron 重新编译 better-sqlite3
bun run desktop:dist      # 以上步骤 + electron-builder 打包
```

`desktop:dist` 后的参数会传给 electron-builder，例如只构建 macOS arm64：

```bash
bun run desktop:dist -- --mac --arm64
```

产物位于 `build/desktop`。原生模块是按构建机器的架构编译的，因此 x86 的 Mac 需要在 x86 的机器上构建。
