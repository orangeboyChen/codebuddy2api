# Storage Choices

| Backend  | Best for                                 | Persistence                      |
| -------- | ---------------------------------------- | -------------------------------- |
| `file`   | Existing deployments or temporary runs   | File directories                 |
| `sqlite` | Single-instance production (recommended) | `.codebuddy_data/storage.sqlite` |
| `pg`     | Multiple instances or high concurrency   | PostgreSQL service               |

Database backends require `CODEBUDDY_STORAGE_ENCRYPTION_KEY`. For a new SQLite deployment, set `CODEBUDDY_STORAGE_BACKEND=sqlite`; mount `.codebuddy_data` only when data must survive container recreation.
