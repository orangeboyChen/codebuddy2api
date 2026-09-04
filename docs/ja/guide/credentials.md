# Credentials

Credentials はプロキシが使用する CodeBuddy アカウントを管理します。

1. **Credentials** を開きます。
2. OAuth ログインを開始し、ブラウザで認証を完了します。
3. コンソールに戻り、一覧を更新します。
4. 期限切れのアカウントは再認証します。
5. アクセスキーを作成し、表示された秘密値を安全な場所へ一度だけ保存します。

API クライアントは `Authorization: Bearer <access-key>` または `x-api-key: <access-key>` を送信します。認証情報ファイルやキーを静的ドキュメントへ含めないでください。
