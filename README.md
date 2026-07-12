# Text Editor

## Remote Inbox（v1.8.0）

Text Editor can accept and edit notes from an iPhone through Cloudflare Tunnel and Cloudflare Access. Setup and security notes are in [Remote Inbox setup](docs/remote-inbox-setup.md). Remote Inbox is off by default. The app starts its HTTP server only on `127.0.0.1`; publishing it through Cloudflare Tunnel is an external setup step.

- Remote Web: full Remote Inbox editing, append, reload, copy, clear, revision-based conflict detection, and configured normal-tab viewing
- Normal tabs on Remote Web: viewing, searching, copying, and safe HTTP/HTTPS link opening only
- PC app: Remote Inbox targets are read-only; selection, copying, and confirmed clearing remain available
- Remote tab viewing is opt-in: select normal tabs allowed for remote viewing in `View > Settings > Remote writing`
- All data-reading and mutation APIs require Cloudflare Access authentication; mutations also require CSRF validation

Electron + TypeScript + CodeMirror 6 で作成した、シンプルな小説・メモ用テキストエディタです。

## 起動方法

```powershell
npm install
npm start
```

`npm start` は TypeScript とレンダラーをビルドしてから Electron を起動します。

ビルド確認:

```powershell
npm run build
```

Windows 用 exe 作成:

```powershell
npm run dist
```

`npm run dist` は `npm run build` 後に electron-builder を実行し、`dist/` 配下に Windows 用インストーラーとポータブル exe を生成します。

出力例:

```text
dist/
  Text Editor Setup 1.8.0.exe
  Text Editor 1.8.0.exe
```

開発中にレンダラーだけ確認する場合:

```powershell
npm run dev
```

## テスト

Playwright で Electron アプリを起動する E2E テストを用意しています。

```powershell
npm run test:e2e
```

テストはビルド後に Electron を起動し、テスト専用の `userData` を使うため、通常の保存データは変更しません。

UI モードで確認する場合:

```powershell
npm run test:e2e:ui
```

主な確認範囲:

- 自動保存
- 上部タブ名からのリネーム
- 全文コピー
- 検索パネル
- 全タブ一括 TXT 出力
- 左ペイン幅の保存と復元
- Recent / Closed からの再オープン
- 左ペインの空白、グループ行、タブ行の右クリックメニュー
- タブ複製
- タブのピン留め
- ステータスバーの行/列/文字数表示
- 箇条書き自動継続と設定保存
- 完全削除前バックアップ
- バックアップ履歴表示と新規タブ復元
- 異常終了後の復元確認
- UI 言語切り替えと復元
- 全体検索と検索結果ジャンプ
- Workspace Export / Import
- タブ分割表示と分割状態復元
- 小タブの追加、切り替え、リネーム、削除
- 大項目グループの作成、D&D、削除
- Remote Inbox 設定の初期値と保存
- 登録済み送信先への追記、未指定送信先の互換動作、不正な送信先の拒否
- Remote Inbox の取得、全文保存、revision 競合、クリア、CSRF、100 KB 制限
- 許可済み通常タブの一覧・本文取得、未認証アクセス、不正なタブ ID の拒否
- Remote Inbox タブの自動作成、初回ピン留め、タイムスタンプ書式
- PC アプリ上の Remote Inbox の読み取り専用化、全文コピー、確認付きクリア

## データ保存場所

保存データは Electron の `userData` 配下に作成されます。

Windows では通常、以下の形式です。

```text
%APPDATA%\texteditor\data
```

exe 化後も保存先は同じく `%APPDATA%\texteditor\data` です。

構成:

```text
data/
  workspace.json
  session.json
  remote-inbox.log
  backups/
    tab-001/
      20260708-032100.json
  tabs/
    index.json
    tab-001.json
    tab-002.json
```

`remote-inbox.log` は Remote Inbox の監査ログで、Remote Inbox を利用して監査イベントが発生した場合に作成されます。Workspace Import 前の退避 zip は常設データとは別に、Electron の `userData` 直下の `workspace-import-backups/` に作成されます。

## 現在の仕様

- Electron アプリとして起動
- OS 標準の Electron メニューバーから主要操作を実行
- アプリ画面内の独自 File / Edit / View メニューは非表示
- 左ペインに現在開いているタブを表示
- 左ペインのタブを大項目グループで整理可能
- 左ペインの幅をドラッグで変更可能
- 左ペインの通常タブ順序をドラッグ&ドロップで変更可能
- File メニューから最近閉じたタブを再オープン可能
- File メニューからバックアップ履歴を開いて新規タブとして復元可能
- File メニューから Workspace Export / Import が可能
- Ctrl+Shift+F で全タブを横断する全体検索が可能
- View メニューから左右2分割のタブ分割表示が可能
- メインタブ配下に本文、メモ、プロットなどの小タブを作成可能
- 新規タブ作成時の小タブ構成をテンプレートで選択可能
- 大項目の作成、リネーム、削除
- 大項目自体のドラッグ&ドロップ並び替え
- 小項目を大項目間、または未分類へドラッグ&ドロップ移動
- タブ追加、リネーム、閉じる、再オープン、完全削除
- 通常タブの右クリックメニューから Open in Main / Open in Sub / Pin / Duplicate / Close / Delete / Remove from Group を実行
- ピン留めしたタブは同じ大項目内の通常タブより上に表示
- タブ複製時は `- Copy` / `- コピー` を付与し、重複時は番号を追加
- 通常タブはエディタ上部のタブ名 input から直接リネーム可能
- CodeMirror 6 による本文編集
- ステータスバーに保存状態、文字数、選択文字数、現在行/列を表示
- CodeMirror 6 標準検索パネルによる検索・置換
- 箇条書き行で Enter を押すと `-` / `*` / `+` / `1.` 形式を簡易的に自動継続
- 行番号表示
- 本文データには行番号を保存しない
- 編集内容を自動保存
- タブ単位のバックアップを自動作成
- アクティブタブ本文の全文コピー
- 起動時に以下を復元
  - アクティブタブ
  - 開いていたタブ
  - 最近開いた、または閉じたタブ
  - 左ペインのセクション展開状態
  - テーマ
  - UI 言語
  - フォントサイズ
  - 箇条書き自動継続設定
  - 左ペイン幅
  - 開いているタブの表示順
  - タブ分割状態
  - アクティブペイン
  - 左右ペインのタブ
  - 左右ペインの小タブ
  - 分割幅
- 前回が異常終了だった場合のみ、起動時に前回状態の復元確認を表示
- 起動時に `session.json` で前回終了状態を確認し、`workspace.json` から表示・設定状態、`tabs/index.json` からタブ一覧を読み込む
- `workspace.json` 内の Remote Inbox 設定も起動時に参照し、有効な場合はローカル HTTP サーバーを構成する
- 起動時に全タブの本文 JSON を一括では読み込まない。ただし、前回開いていたタブについては起動時バックアップ作成のためメインプロセスが読み込む
- 本文 JSON はタブを開いた時に読み込む
- 一度開いた本文はメモリキャッシュする
- 現在開いている小タブを TXT 出力可能
- 全タブを `tabs/index.json` の順序で 1 つの TXT に一括出力可能
- ダークモード、ライトモード切り替え
- UI 言語を英語 / 日本語で切り替え
- 右側に簡易ミニマップを表示

### Close と Delete

- `Close` は確認ダイアログを表示せず、タブを左ペインの開いている一覧から外すだけです
- `Close` では `tabs/tab-xxx.json` と `tabs/index.json` 上のタブ情報を削除せず、所属グループも維持します
- 閉じたタブは `File > Open Recent / Closed` から再オープンできます
- `Delete` は確認ダイアログを表示し、確認後にタブ JSON と `tabs/index.json` 上の情報を削除します
- `Delete` の直前には最終バックアップを強制作成します。バックアップ作成に失敗した場合でも削除処理は続行します

## Remote Inbox / Remote Web

Remote Inbox は `View > Settings...` の `Remote writing` / `遠隔書き込み` で設定します。初期状態は無効で、既定ポートは `48731`、既定の受信先名は `Remote Inbox` です。

### 設定と送信

- 送信先候補を複数登録でき、Web 側では登録済み候補だけを選択できます
- 送信先名は空文字、制御文字、改行を許可せず、1件120文字以内、最大30件です
- `POST /api/append` で `target` を省略した既存クライアントは、従来どおり既定の受信先へ追記します
- 選択した受信先タブが存在しない場合は自動作成し、初回作成時にピン留めして開いているタブへ追加します
- タイムスタンプ有効時は `[YYYY-MM-DD HH:mm]` の直下に本文を置き、受信メモ同士は空行で区切ります
- Web の追記欄は `Ctrl+Enter` または `Command+Enter` でも送信できます

### Remote Web の操作

Remote Web の `Remote Inbox` モードでは、登録済み受信先について本文取得、全文編集・保存、再読み込み、全文コピー、クリア、追記ができます。全文保存とクリアは現在の `revision` を送信し、古い画面からの更新は `409 Conflict` で拒否します。全文保存・追記・クリアはいずれもPCアプリの既存タブ保存処理を経由し、タブ本文、更新日時、revision、表示中のエディタを更新します。

保存状態の表示は次のとおりです。

- 読み込み成功後は `HH:mm 更新` を表示します
- 全文保存またはクリア成功後は `保存済み　HH:mm 更新` を表示します。revision番号と秒は通常表示しません
- 保存中は `保存中`、失敗時は操作に応じたエラーを表示します
- `セッション回復` ボタンは通常非表示で、読み込み・保存・追記の失敗またはrevision競合時だけ表示します。押すと現在の受信先を再読み込みします
- このWeb上の回復操作と、PCアプリ起動時の異常終了後の復元確認は別の機能です

`タブ閲覧` モードでは、設定画面で明示的に許可した通常タブだけを一覧・閲覧できます。初期状態では通常タブを1件も公開しません。公開対象は内部タブIDで検証され、Remote Inbox自身、未許可ID、存在しないID、パス形式の値は拒否します。通常タブの本文はプレーンテキストの読み取り専用表示で、簡易検索、再読み込み、全文コピー、HTTP/HTTPS URLのリンク表示に対応します。リンクは別画面で開き、`noopener noreferrer` を設定します。

互換用の `GET /api/read` は、登録済み受信先の読み取り専用取得、新しい順／古い順、カーソルによる追加読み込みに対応します。1回の返却は最大100件かつ約50 KBです。

### PC アプリ側の制限

- Remote Inbox の受信先候補と同名のタブは CodeMirror の読み取り専用状態になり、タイトル変更、本文入力、貼り付け、切り取り、Undo／Redoによる変更、子タブ追加、ドラッグ移動を許可しません
- 文字列選択、通常のコピー、`Copy All` / `全文コピー` は利用できます
- タブの右クリックメニューから確認付きで全文をクリアできます。クリアはrevisionを更新し、通常のUndo履歴には追加しません

### セキュリティと保存

- Cloudflare Access JWTはJWKSによるRS256署名、issuer、AUD、許可メールアドレスを検証します
- 変更系APIはCSRF Cookieとヘッダー、Origin、JSON Content-Typeを検証します
- リクエスト本文は100 KBまで、認証メールアドレス単位のレート制限は1分10回です
- 読み取り・更新・クリア・タブ一覧・通常タブ閲覧を `data/remote-inbox.log` に最大500件記録し、本文そのものは記録しません
- Workspace Exportには `workspace.json` が入るため、Team Domain、AUD、許可メールアドレス、送信先候補、通常タブの公開設定も含まれます
- Accessトークン、Tunnel認証情報、CSRF Cookieは保存データに保持しないため、Workspace Exportには含まれません

## メニュー

アプリ内には File / Edit / View の独自メニューバーを常時表示しません。
操作は Electron のネイティブメニューバーから実行します。

File:

- New Tab
- New Group
- Import TXT...
- Import TXT Files...
- Export TXT
- Export All TXT
- Export Workspace...
- Import Workspace...
- Backups
- Open Recent / Closed
- Quit

Edit:

- Undo
- Redo
- Copy All
- Find
- Find in Workspace
- Replace
- Find Next
- Find Previous

View:

- Toggle Theme
- Switch to Japanese / 英語に切替
- Settings...
- Split Right
- Close Split
- Focus Left Editor
- Focus Right Editor
- Font Size Up
- Font Size Down
- Reload
- Toggle Developer Tools

Window:

- Minimize
- Close

## タブ分割表示

`View > Split Right` または `Ctrl+\` で左右2分割表示にできます。

- 通常状態は左エディタのみの1ペイン表示
- 分割中は左右それぞれに CodeMirror エディタを表示
- 左ペインのタブ一覧をクリックすると、現在フォーカス中のエディタペインで開く
- タブ右クリックメニューの `Open in Main` / `メインで開く` で左エディタへ直接開く
- タブ右クリックメニューの `Open in Sub` / `サブで開く` で右エディタへ直接開く
- `Open in Sub` は分割表示がない場合、自動的に右分割を作成
- フォーカス中ペインが不明な場合は左エディタで開く
- エディタ上部のタブ名 input は、フォーカス中ペインのタブ名を編集
- 左右ペインそれぞれで別の小タブを開ける
- 同じタブ、同じ小タブを左右で開いた場合、片方の編集内容はもう片方にも反映
- 左右境界をドラッグして分割幅を変更可能
- `View > Close Split` で1ペイン表示へ戻る

分割状態は `workspace.json` の `layout` に保存され、再起動後に復元されます。

## 小タブ

1つのメインタブの下に補助ドキュメントを持てます。

例:

```text
第一話
  本文
  メモ
  プロット
  設定
```

- 既存形式の `tab-xxx.json` はそのまま読み込み可能
- `childTabs` がない旧形式は、自動的に `本文` 小タブとして扱う
- 新規メインタブは選択中の新規タブテンプレートに従って小タブを初期作成
- 通常タブでは小タブバーの `+` から小タブを追加
- 各エディタペイン上部の小タブバーから、そのペイン内で即時に小タブを切り替え
- 通常タブの小タブ右クリックメニューから Open in Main / Open in Sub / Rename / Delete を実行
- `本文` 小タブは削除不可
- 小タブ編集も自動保存とバックアップ対象
- `tabs/index.json` の `wordCount` は `本文` 小タブの文字数を使用
- 分割表示中は左右ペインごとに別の小タブを開ける

保存時も旧互換のため、`content` には `本文` 小タブの内容を残します。

## 新規タブテンプレート

`View > Settings...` の `New tab template` / `新規タブテンプレート` で、新規タブ作成時の小タブ構成を選択できます。

初期設定は `Simple` / `シンプル` です。

- Simple / シンプル: 本文
- Novel / 小説: 本文、メモ、プロット
- Reference / 資料: 本文、設定
- Custom / カスタム: ユーザー定義

カスタムテンプレートでは、小タブ名の追加、削除、リネーム、ドラッグ&ドロップ並び替えができます。

- `本文` は常に先頭に固定
- `本文` は削除不可
- `本文` は名称変更不可
- テンプレート変更は次回以降の `New Tab` から反映
- 既存タブの小タブ構成は変更しない

設定は `workspace.json` に保存されます。

同じ設定画面で `Continue lists automatically` / `箇条書きを自動継続` を切り替えできます。

- 初期値は ON
- `-` / `*` / `+` / `1.` の簡易的な箇条書きを Enter で継続
- 空の箇条書き行で Enter を押すと箇条書きを終了
- 設定は `workspace.json` の `autoContinueLists` に保存

## TXT 読み込み

`File > Import TXT...` で単一の `.txt` ファイルを新規メインタブとして読み込みます。

`File > Import TXT Files...` では複数の `.txt` ファイルを選択でき、1ファイルごとに1つのメインタブを作成します。

- ファイル名から拡張子を除いた名前をタブ名として使用
- TXT 本文は `本文` 小タブの `content` として保存
- 選択中の新規タブテンプレートに従って小タブを作成
- 現在選択中の大項目があればその大項目へ追加し、なければ未分類へ追加
- 読み込み後、単一読み込みではそのタブ、複数読み込みでは最初のタブを左エディタで開く
- 読み込んだタブは通常タブと同じく自動保存、バックアップ、全体検索、TXT 出力、Workspace Export / Import の対象

対応文字コード:

- UTF-8 を優先
- UTF-8 として読めない場合は Shift_JIS として読み込み

## 大項目グループ

左ペインのメインタブを大項目でグループ化できます。

例:

```text
第一章
  第一話
  第二話

設定資料
  世界観

未分類
  メモ
```

- `File > New Group`、または左ペインの空白部分の右クリックメニューから大項目を作成
- 左ペインの空白部分の右クリックメニューから新規タブを未分類に作成
- 大項目クリックで展開 / 格納
- 大項目右クリックメニューから Add New Tab / Rename / Delete Group を実行
- Delete Group はタブを削除せず、配下タブを未分類へ移動
- 未分類は常に存在する固定グループで、展開 / 格納は可能、リネームと削除は不可
- 未分類の右クリックメニューでは新規タブ追加のみ実行可能
- タブ行右クリックメニューから Rename / Duplicate / Close / Delete / Remove from Group を実行
- Duplicate は本文と小タブをコピーし、同じ大項目内に「Copy」または「コピー」を付けたタブを作成
- 未分類内のタブでは Remove from Group は表示しない
- 小項目はドラッグ&ドロップで同じ大項目内の並び替え、別大項目への移動、未分類への移動が可能
- 折りたたみ中の大項目タイトルへ小項目をドロップすると、その大項目の末尾に追加
- 大項目自体もドラッグ&ドロップで並び替え可能
- 大項目を移動した場合、その大項目は自動的に折りたたまれる
- 新規タブは現在選択中の大項目へ追加され、選択中大項目がなければ未分類へ追加
- タブを閉じても所属大項目は維持

大項目構造は `tabs/index.json` に保存されます。既存の `tabs/index.json` に `groups` がない場合は、全タブを未分類として自動的に扱います。

## ローカライズ

UI 言語は `View > Switch to Japanese` または `Ctrl+Shift+L` で英語 / 日本語を切り替えます。

- 言語設定は `workspace.json` の `locale` に保存
- 対応言語は `en` と `jp`
- 再起動後も前回の言語を復元
- CodeMirror 標準検索パネルの内部表示は CodeMirror 側の標準 UI を使用

## 検索・置換

CodeMirror 6 の標準検索パネルを使用します。検索状態は本文 JSON には保存しません。

全体検索は `Ctrl+Shift+F` で左タブペインとは別の検索ペインを開き、`tabs/index.json` に存在する全タブのタイトルと本文を横断検索します。

- 未オープンタブも検索対象
- 検索時のみ `tabs/tab-xxx.json` を読み込み
- 部分一致、日本語検索に対応
- 正規表現、置換、大文字小文字区別は未対応
- `childTabs` がある場合は全小タブを検索対象にする
- 結果には `大項目 > メインタブ > 小タブ` を表示
- 結果クリックで対象メインタブと小タブを開き、本文一致は該当行へスクロールして検索語を選択

ショートカット:

- `Ctrl+F`: 検索
- `Ctrl+Shift+F`: 全体検索
- `Ctrl+H`: 置換パネルを開く
- `F3`: 次を検索
- `Shift+F3`: 前を検索

## ショートカット一覧

- `Ctrl+N`: 新規タブ
- `Ctrl+Z`: 元に戻す
- `Ctrl+Y`: やり直し
- `Ctrl+S`: 現在タブを TXT 出力
- `Ctrl+Shift+B`: バックアップ履歴
- `Ctrl+Shift+R`: 最近閉じたタブ
- `Ctrl+Shift+C`: 本文全文コピー
- `Ctrl+F`: 現在タブ内検索
- `Ctrl+Shift+F`: 全体検索
- `Ctrl+H`: 置換
- `F3`: 次を検索
- `Shift+F3`: 前を検索
- `Ctrl+Shift+L`: UI 言語切り替え
- `Ctrl+\`: 右に分割
- `Ctrl+1`: 左エディタへフォーカス
- `Ctrl+2`: 右エディタへフォーカス
- `Ctrl++`: フォントサイズを大きく
- `Ctrl+-`: フォントサイズを小さく

## Workspace Export / Import

`File > Export Workspace...` で `%APPDATA%\texteditor\data` 配下の個人データを zip として出力します。

出力ファイル名:

```text
TextEditorWorkspace_YYYYMMDD_HHMMSS.zip
```

zip 構成:

```text
workspace.json
tabs/
backups/
version.json
```

`session.json` と `remote-inbox.log` は Workspace Export に含めません。

`version.json` 例:

```json
{
  "appVersion": "1.8.0",
  "workspaceVersion": 1,
  "createdAt": "2026-07-08T12:00:00.000Z"
}
```

`appVersion` にはエクスポートを実行したアプリのバージョンが入ります。上記は現行の `package.json` に対応する例です。

`File > Import Workspace...` では zip を選択し、互換性確認後に現在のWorkspaceを自動バックアップしてからデータを上書きします。

- 現在対応する `workspaceVersion` は `1`
- 異なる `workspaceVersion` の場合は読み込みを中止
- Import 完了後はアプリ再起動が必要
- Import 前の自動バックアップは Electron の `userData` 配下 `workspace-import-backups/` に保存

## TXT 出力

現在開いている小タブだけを出力する `Export TXT` と、全タブを 1 つの `.txt` にまとめる `Export All TXT` があります。

`Export All TXT` は `tabs/index.json` の順序で未オープンタブも読み込み、各メインタブの `本文` 小タブのみを出力対象にします。各タブの前にタイトル見出しを入れます。

出力例:

```text
# 第一話

本文...

# 第二話

本文...
```

## 保存ファイル例

`workspace.json`

```json
{
  "activeTabId": "tab-001",
  "openedTabIds": ["tab-001", "tab-002"],
  "recentTabIds": ["tab-003", "tab-001"],
  "expandedIds": ["opened"],
  "theme": "dark",
  "locale": "en",
  "fontSize": 15,
  "sidebarWidth": 248,
  "autoContinueLists": true,
  "newTabTemplate": "simple",
  "templates": {
    "custom": ["本文", "メモ", "人物", "設定"]
  },
  "remoteInbox": {
    "enabled": false,
    "port": 48731,
    "targetTabName": "Remote Inbox",
    "targetTabNames": ["Remote Inbox"],
    "remoteReadableTabIds": [],
    "includeTimestamp": true,
    "notifyOnReceive": true,
    "accessTeamDomain": "",
    "accessAudience": "",
    "allowedEmail": ""
  },
  "layout": {
    "splitMode": "vertical",
    "activePaneId": "left",
    "panes": [
      {
        "id": "left",
        "activeTabId": "tab-001",
        "activeChildTabId": "main"
      },
      {
        "id": "right",
        "activeTabId": "tab-002",
        "activeChildTabId": "memo"
      }
    ],
    "splitRatio": 0.5
  }
}
```

`tabs/index.json`

```json
{
  "groups": [
    {
      "id": "group-001",
      "title": "第一章",
      "tabIds": ["tab-001"],
      "collapsed": false,
      "updatedAt": "2026-07-08T00:00:00.000Z"
    },
    {
      "id": "group-002",
      "title": "設定資料",
      "tabIds": ["tab-002"],
      "collapsed": true,
      "updatedAt": "2026-07-08T00:00:00.000Z"
    }
  ],
  "ungroupedTabIds": ["tab-003"],
  "tabs": [
    {
      "id": "tab-001",
      "title": "第一話",
      "updatedAt": "2026-07-08T00:00:00.000Z",
      "wordCount": 1200,
      "pinned": true
    }
  ]
}
```

旧形式の `tabs/index.json` も引き続き有効です。`groups` がない場合は `groups: []`、`ungroupedTabIds` は既存 `tabs` の順序として扱われます。`pinned` がない既存タブは `false` として扱われます。

`tabs/tab-001.json`

```json
{
  "id": "tab-001",
  "title": "第一話",
  "content": "本文...",
  "activeChildTabId": "main",
  "childTabs": [
    {
      "id": "main",
      "title": "本文",
      "content": "本文...",
      "updatedAt": "2026-07-08T00:00:00.000Z"
    },
    {
      "id": "memo",
      "title": "メモ",
      "content": "メモ本文...",
      "updatedAt": "2026-07-08T00:00:00.000Z"
    }
  ],
  "updatedAt": "2026-07-08T00:00:00.000Z",
  "revision": 0
}
```

旧形式の `tab-xxx.json` も引き続き有効です。`childTabs` がない場合、`content` が `本文` 小タブの内容として扱われます。

## バックアップ仕様

バックアップはタブ単位で `data/backups/{tabId}/` に保存されます。

```text
data/
  backups/
    tab-001/
      20260708-032100.json
      20260708-033100.json
```

- バックアップ内容は `tabs/tab-xxx.json` と同等の JSON
- 小タブ対応後は `childTabs` を含むタブ JSON 全体をバックアップ
- 旧形式バックアップは復元時に `本文` 小タブとして扱う
- 起動時に、前回開いていたタブのバックアップを作成
- 編集中は一定間隔でアクティブタブのバックアップを作成
- 同一内容のバックアップは連続作成しない
- 各タブ最大 30 件まで保持
- 最大件数を超えた古いバックアップは自動削除
- 完全削除時は、元 JSON 削除前に最終バックアップを作成
- バックアップ作成失敗時はアプリを止めず、ステータスにエラー表示
- `File > Backups` から全タブのバックアップ履歴を開き、日時、対象タブ名、サイズ、プレビューを確認可能
- 復元は標準で「新規タブとして復元」し、現在のタブ内容を直接上書きしない

## 異常終了後の復元確認

通常終了時は `data/session.json` に正常終了状態を記録します。

- 前回の終了処理が完了していない場合のみ、起動時に復元確認を表示
- `Restore` / `復元する` を選ぶと従来通り前回の表示状態を復元
- `Start without restoring` / `復元せず起動` を選ぶと、タブJSONやバックアップは削除せず、表示状態だけ空で起動
- `Cancel` / `キャンセル` を選ぶと起動を中止
- 通常終了後の次回起動では確認を表示しない

## 未実装予定機能

- エディタ設定の詳細化
- ショートカット設定
- 外部フォルダをワークスペースとして選択する機能
- より精密なミニマップ表示
- バックアップ間の差分比較と、より詳細な履歴閲覧 UI

## GitHub 公開と配布

`dist/` は `npm run dist` で生成される配布物の出力先であり、Git 管理には含めません。Windows 用の exe / installer を配布する場合は、必要に応じて GitHub Releases のリリースアセットとして添付してください。

公開リポジトリには `dist/`、`node_modules/`、`test-results/`、`playwright-report/`、ローカルの userData 相当ファイルを含めないでください。保存データは通常 `%APPDATA%\texteditor\data` に作成されます。

基本コマンド:

```bash
npm install
npm start
npm run build
npm run dist
npm run test:e2e
```
