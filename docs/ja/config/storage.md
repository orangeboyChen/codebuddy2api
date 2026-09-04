# ストレージの選択

| バックエンド | 用途                               | 永続化                           |
| ------------ | ---------------------------------- | -------------------------------- |
| `file`       | 既存環境との互換性または一時実行   | ファイルディレクトリ             |
| `sqlite`     | 単一インスタンスの本番環境（推奨） | `.codebuddy_data/storage.sqlite` |
| `pg`         | 複数インスタンスまたは高負荷       | PostgreSQL サービス              |

DB バックエンドでは `CODEBUDDY_STORAGE_ENCRYPTION_KEY` が必要です。新規 SQLite 構築では `CODEBUDDY_STORAGE_BACKEND=sqlite` を設定し、コンテナ再作成後もデータを残す場合だけ `.codebuddy_data` をマウントします。
