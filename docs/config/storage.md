# 存储选择

| 后端     | 适用场景               | 持久化方式                       |
| -------- | ---------------------- | -------------------------------- |
| `file`   | 兼容已有部署或临时运行 | 文件目录                         |
| `sqlite` | 单实例生产部署（推荐） | `.codebuddy_data/storage.sqlite` |
| `pg`     | 多实例或高并发部署     | PostgreSQL 服务                  |

数据库后端都需要设置 `CODEBUDDY_STORAGE_ENCRYPTION_KEY`。新部署使用 SQLite 时，只需设置 `CODEBUDDY_STORAGE_BACKEND=sqlite`；是否挂载 `.codebuddy_data` 取决于你是否需要容器重建后保留数据。
