# Storage Choices

| Backend  | Best for                                 | Persistence                      |
| -------- | ---------------------------------------- | -------------------------------- |
| `file`   | Existing deployments or temporary runs   | File directories                 |
| `sqlite` | Single-instance production (recommended) | `.codebuddy_data/storage.sqlite` |
| `pg`     | Multiple instances or high concurrency   | PostgreSQL service               |

Database backends require `CODEBUDDY_STORAGE_ENCRYPTION_KEY`. For a new SQLite deployment, set `CODEBUDDY_STORAGE_BACKEND=sqlite`; mount `.codebuddy_data` only when data must survive container recreation.

> **Rollback warning**: on a database backend, documents are written as `aes-256-gcm:v2` from the first write after upgrading, and older releases cannot decrypt them. Back the database up before upgrading; to roll back afterwards you must restore that pre-upgrade backup. Decryption also needs both the passphrase and the `storage-crypto/kdf-salt` row in the database — back up both.
