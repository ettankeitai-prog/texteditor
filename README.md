# Text Editor

Electron + TypeScript + CodeMirror 6 で作成した、シンプルな小説・メモ用テキストエディタです。

## 起動方法

```powershell
npm install
npm start
```

`npm start` は TypeScript とレンダラーをビルドしてから Electron を起動します。

開発起動:

```powershell
npm start
```

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
  Text Editor Setup 1.4.0.exe
  Text Editor 1.4.0.exe
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
- 完全削除前バックアップ
- バックアップ一覧表示と復元
- UI 言語切り替えと復元
- 全体検索と検索結果ジャンプ
- Workspace Export / Import
- タブ分割表示と分割状態復元
- 小タブの追加、切り替え、リネーム、削除
- 大項目グループの作成、D&D、削除

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
  backups/
    tab-001/
      20260708-032100.json
  tabs/
    index.json
    tab-001.json
    tab-002.json
```

## 現在の仕様

- Electron アプリとして起動
- OS 標準の Electron メニューバーから主要操作を実行
- アプリ画面内の独自 File / Edit / View メニューは非表示
- 左ペインに現在開いているタブを表示
- 左ペインのタブを大項目グループで整理可能
- 左ペインの幅をドラッグで変更可能
- 左ペインのタブ順序をドラッグ&ドロップで変更可能
- File メニューから最近閉じたタブを再オープン可能
- File メニューからバックアップ一覧を開いて復元可能
- File メニューから Workspace Export / Import が可能
- Ctrl+Shift+F で全タブを横断する全体検索が可能
- View メニューから左右2分割のタブ分割表示が可能
- メインタブ配下に本文、メモ、プロットなどの小タブを作成可能
- 新規タブ作成時の小タブ構成をテンプレートで選択可能
- 大項目の作成、リネーム、削除
- 大項目自体のドラッグ&ドロップ並び替え
- 小項目を大項目間、または未分類へドラッグ&ドロップ移動
- タブ追加、リネーム、閉じる、再オープン、完全削除
- タブ行の右クリックメニューから Rename / Duplicate / Close / Delete / Remove from Group を実行
- エディタ上部のタブ名 input から直接リネーム可能
- CodeMirror 6 による本文編集
- CodeMirror 6 標準検索パネルによる検索・置換
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
- 左ペイン幅
- 開いているタブの表示順
  - タブ分割状態
  - アクティブペイン
  - 左右ペインのタブ
  - 左右ペインの小タブ
  - 分割幅
- 起動時は `workspace.json` と `tabs/index.json` のみ読み込む
- 本文 JSON はタブを開いた時に読み込む
- 一度開いた本文はメモリキャッシュする
- 現在のタブを TXT 出力可能
- 現在開いている小タブを TXT 出力可能
- 全タブを `tabs/index.json` の順序で 1 つの TXT に一括出力可能
- ダークモード、ライトモード切り替え
- UI 言語を英語 / 日本語で切り替え
- 右側に簡易ミニマップを表示

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

Version 1.3 では、1つのメインタブの下に補助ドキュメントを持てます。

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
- 小タブバーの `+` から小タブを追加
- 各エディタペイン上部の小タブバーから、そのペイン内で即時に小タブを切り替え
- 小タブ右クリックメニューから Open in Main / Open in Sub / Rename / Delete を実行
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

Version 1.4 では、左ペインのメインタブを大項目でグループ化できます。

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
- `Ctrl+S`: 現在タブを TXT 出力
- `Ctrl+Shift+B`: バックアップ一覧
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

`version.json` 例:

```json
{
  "appVersion": "1.4.0",
  "workspaceVersion": 1,
  "createdAt": "2026-07-08T12:00:00.000Z"
}
```

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
  "newTabTemplate": "simple",
  "templates": {
    "custom": ["本文", "メモ", "人物", "設定"]
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
      "wordCount": 1200
    }
  ]
}
```

旧形式の `tabs/index.json` も引き続き有効です。`groups` がない場合は `groups: []`、`ungroupedTabIds` は既存 `tabs` の順序として扱われます。

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
  "updatedAt": "2026-07-08T00:00:00.000Z"
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
- `File > Backups` から選択中タブのバックアップ一覧を開き、確認後に復元

## 未実装予定機能

- エディタ設定の詳細化
- ショートカット設定
- 外部フォルダをワークスペースとして選択する機能
- より精密なミニマップ表示
- 自動保存履歴の詳細 UI

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
