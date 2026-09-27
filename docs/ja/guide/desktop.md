# デスクトップアプリ

各リリースには Docker イメージに加えて Electron デスクトップビルドが含まれます。macOS（Apple silicon と Intel）、Windows、Linux（x86_64 と arm64）に対応しています。

## 仕組み

デスクトップアプリは Electron ウィンドウと、同じインストーラーに同梱されたゲートウェイで構成されます。起動時にメインプロセスがゲートウェイ（Docker イメージと同じ Next.js standalone サーバー）を起動し、`/health` が応答するまで待ってからコンソール画面を開きます。

- ゲートウェイは `127.0.0.1` のみで待ち受け、LAN には公開されません。
- 既定ポートは `8001` です。使用中の場合は空いている次のポートへ移動します。`CODEBUDDY_DESKTOP_PORT` で固定もできます。
- macOS ではウィンドウを閉じてもゲートウェイは動き続け、`/v1/*` は利用可能なままです。アプリを終了すると停止します。

## データの保存場所

データはインストール先ではなく Electron の `userData` ディレクトリに書き込まれます。

| パス                     | 内容                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `data/`                  | ファイルストレージのディレクトリ（既定では `storage.sqlite`） |
| `credentials/`           | CodeBuddy の認証情報ファイル                                  |
| `storage-encryption-key` | 初回起動時に生成されるストレージ暗号化キー（権限 `0600`）     |

デスクトップアプリは既定で `sqlite` バックエンドを使い、初回起動時に暗号化キーを生成するため、認証情報とアクセスキーは暗号化されて保存されます。**`storage-encryption-key` を削除すると、暗号化済みのデータは復元できなくなります。** これはセルフホスト時と同じ契約です。バックアップはデータベースとキーをセットで取得してください。

環境変数は従来どおり優先されます。`CODEBUDDY_STORAGE_BACKEND`、`DATABASE_URL`、`CODEBUDDY_STORAGE_ENCRYPTION_KEY` を設定すれば、PostgreSQL への接続や既存キーの再利用ができます。

## 署名について

ビルド成果物はコード署名されていません。macOS では初回起動時に Finder で右クリックして「開く」を選択し、Windows では SmartScreen の警告で「実行」を選んでください。

## ソースからビルドする

```bash
bun install
bun run build
bun run desktop:prepare   # ゲートウェイの構成、メインプロセスのバンドル、better-sqlite3 の Electron 向け再ビルド
bun run desktop:dist      # 上記に加えて electron-builder でパッケージング
```

`desktop:dist` 以降の引数は electron-builder に渡されます。単一ターゲットをビルドする場合は次のようにします。

```bash
bun run desktop:dist -- --mac --arm64
```

成果物は `build/desktop` に出力されます。ネイティブモジュールはビルドしたマシンのアーキテクチャ向けにコンパイルされるため、x86 の Mac は x86 のマシンでビルドする必要があります。
