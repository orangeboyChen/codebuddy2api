# 存储选择

| 后端     | 适用场景               | 持久化方式                       |
| -------- | ---------------------- | -------------------------------- |
| `file`   | 兼容已有部署或临时运行 | 文件目录                         |
| `sqlite` | 单实例生产部署（推荐） | `.codebuddy_data/storage.sqlite` |
| `pg`     | 多实例或高并发部署     | PostgreSQL 服务                  |

数据库后端都需要设置 `CODEBUDDY_STORAGE_ENCRYPTION_KEY`。新部署使用 SQLite 时，只需设置 `CODEBUDDY_STORAGE_BACKEND=sqlite`；是否挂载 `.codebuddy_data` 取决于你是否需要容器重建后保留数据。

> **降级提示**：数据库后端的文档在首次写入后会使用 `aes-256-gcm:v2` 加密，旧版本无法解密。请先备份数据库再升级，升级后如需回退，只能回滚到升级前的数据库备份。另外解密同时需要密钥和库中的 `storage-crypto/kdf-salt` 记录，两者都要备份。
