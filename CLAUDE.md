# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```bash
# 依存インストール
npm install

# ローカル開発（Vercel Functions + 環境変数 .env を読む）
vercel dev

# Vercel へデプロイ
vercel
```

テストフレームワークは未導入。動作確認は README.md の curl 例で行う。

## アーキテクチャ概要

このプロジェクトは **2層構造**になっている。

### 層1：バックエンド通知エンジン（`api/` + `lib/`）

Vercel Serverless Functions で動作する Node.js (ESM) の API 群。
外部 Webhook から新着アイテムを受け取り、重複排除・フィルタリング・OneSignal プッシュ通知を行う。

**データフロー:**

```
外部 Webhook → POST /api/webhook/ingest
  → lib/sns-normalizer.js  （X/Instagram の生データを {title, body, url} に正規化）
  → lib/utils.js           （アイテムごとに seen:userId:sourceId:sha256 キーを生成）
  → lib/redis.js           （Upstash Redis で既読チェック & seen 書き込み）
  → lib/filters.js         （除外ワード判定 → 重要度カテゴリ判定）
  → lib/notification.js    （OneSignal REST API で全購読者に送信）
```

**タイムゼロ・ベースライン（核心コンセプト）:**
`POST /api/categories/register` または `POST /api/sources/:sourceId/baseline` を呼ぶと、その時点で存在するアイテムを全て seen 済みとしてマークする。以降の ingest では新着だけが通知対象になる。「登録前の情報は絶対に通知しない」が不変の要件。

**フィルタリングの仕組み（`lib/filters.js`）:**
- `EXCLUDE_WORDS`（LIVE/ツアー/チケット/会場 等）を含むアイテムは通知しない
- `CATEGORY_PATTERNS` でカテゴリ（予約/受付開始・再販/在庫復活 等）に分類
- `CTA_PRIORITY_WORDS`（予約開始・抽選受付・本日締切 等）に該当すれば `[重要]` プレフィクスを付与

**Redis キー設計:**
- `seen:userId:sourceId:sha256hash` — 既読フラグ（TTL 1年）
- `categories:tree` — カテゴリツリー全体（TTL 1年）
- `sub:userId:categoryId` — ユーザー購読メタデータ（TTL 1年）

**Vercel rewrite（`vercel.json`）:**
`/api/sources/:sourceId/baseline` → `api/sources-baseline.js` にルーティングされる。Vercel の動的パスはファイルベースで制御できないため rewrite を使っている。

### 層2：フロントエンド PWA（`public/index.html`）

単一HTMLファイルのモバイルファーストSPA。React等は不使用、バニラJS + インラインCSS。
現時点では UI はほぼモック（データは静的 `mockHistory` 配列）。バックエンドとの通信は `api/chat.js`（Gemini）のみ実装済み。

**6画面構成（ボトムナビゲーション）:**

| 画面ID | サブタイトル | 役割 |
|--------|------------|------|
| `home` | CORE SYSTEM | 監視対象カテゴリ選択・見守り開始 |
| `history` | NOTIFICATIONS | キャッチした情報の一覧 |
| `insight` | RADAR INSIGHT | 市場状況・検索 |
| `settings` | WATCHING | 見守りリスト・カレンダー連携 |
| `link` | SYSTEM LINK | プラン選択・ショップ連携 |
| `chat` | COMMUNITY | コミュニティ情報共有 |

## UI デザイン原則（「11pxの美学」）

このアプリの UI は「暗闇の中の精密機器」というコンセプト。以下のルールは崩さない。

**カラーパレット（CSS変数）:**
```css
--obsidian: #000000        /* 背景 */
--amethyst: #9b59b6        /* アクセント・選択状態・アイコン */
--champagne-gold: #F7E7CE  /* ラベル・メタ情報 */
--dark-glass: rgba(255,255,255,0.03)  /* カード背景 */
--border-purple: rgba(155,89,182,0.3) /* カード枠線 */
```

**11pxのルール:**
- `.meta-11px`、`.shop-status-text`、`.item-meta`、`.link-guide-11px`、`.error-text-11px` はすべて `font-size: 11px`
- 補助情報・ステータス・エラー・誘導テキストはすべて 11px に統一
- 「11pxの精度で同期」「11pxの繊細な通知」という文言がアプリ内に出てくるほど、このサイズはコンセプトの一部

**コンポーネントルール:**
- カード類は `.transparent-box`（ガラスモーフィズム、`border-radius: 2px`）— 角は極力尖らせる
- ボタンは `.btn-purple`（全幅、大文字、`letter-spacing: 4px`）
- ラベルは `.gold-label`（シャンパンゴールド、大文字、`letter-spacing: 2.5px`）
- 選択状態は `border-color: amethyst` + `box-shadow: 0 0 18px rgba(155,89,182,0.4)`
- ヒーロー背景画像は `filter: brightness(0.25)` + `scale(1.1)` で暗く沈める

**広告レイヤー（FREE プランのみ）:**
- 起動時・復帰時（30分以上離脱）に `#startup-ad-overlay` を3秒間表示
- `#home-banner-ad` をホーム画面フッターに表示
- STANDARD 以上では非表示

## 環境変数

| 変数名 | 用途 |
|--------|------|
| `WEBHOOK_SECRET` | X-Webhook-Secret ヘッダ認証（必須） |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis |
| `ONESIGNAL_APP_ID` | OneSignal |
| `ONESIGNAL_API_KEY` | OneSignal |
| `GEMINI_API_KEY` | Gemini AI（`api/chat.js` 用） |

ローカル開発は `.env.example` をコピーして `.env` を作成する。

---

## エージェント・ペルソナ（3視点自己レビュー）

コード修正・機能追加・デプロイのすべての判断において、以下の3人格で自己レビューを行う。
**3人全員が「OK」を出さない限り、デプロイしない。**

### 🔧 職人（Craftsman）
> 「11pxの美学を一切妥協しない」

チェック項目：
- すべての補助テキストが `font-size: 11px` か
- `border-radius` は `2px` 統一か（広告バナー含む）
- `.btn-purple` は `letter-spacing: 4px`、`.gold-label` は `2.5px` か
- CSS変数（`--obsidian` / `--amethyst` / `--champagne-gold`）以外のハードコードカラーが混入していないか
- 新規コンポーネントに `.transparent-box` ガラスモーフィズムが適用されているか

### 🛡️ 門番（Gatekeeper）
> 「バグとセキュリティの穴を一切通さない」

チェック項目：
- ユーザー入力がすべてバリデーション・サニタイズされているか
- `restrictedKeywords` フィルタが広告連動箇所すべてに適用されているか
- API エンドポイントに `WEBHOOK_SECRET` 認証が通っているか
- `console.log` にシークレット・個人情報が出力されていないか
- 新規関数が定義されず呼び出しだけ存在する（`postChat()` 再発防止）はないか
- デプロイ前に `vercel logs` でランタイムエラーがないか確認したか

### 🎨 デザイナー（Designer）
> 「暗闇の中の精密機器。ユーザーは0.1秒で美しさを感じなければならない」

チェック項目：
- 新UI要素が「暗闇の中の精密機器」コンセプトと調和しているか
- タップターゲットは最低44pxか（モバイルファースト）
- アニメーション（transition）は `0.3s ease` 基準で統一されているか
- 情報密度が高すぎて圧迫感を与えていないか（ガラスモーフィズムの余白を守る）
- FREEプランの広告が有料プランの体験を著しく損なっていないか

---

## ナレッジ・ベース（失敗と学習）

> **セッション開始時に必ずここを読む。過去の失敗を繰り返すな。**

### KBL-001：不用意なファイル全体書き換えの禁止（2026-03-17）

**何が起きたか:**
`index.html` の修正作業中に、ファイル全体を `Write` ツールで上書きする操作が発生し、
意図しないコンテンツの消失・復旧対応が必要になった。

**根本原因:**
「修正箇所が多い」と判断した際に、差分編集（`Edit`）ではなく全体書き換え（`Write`）を選択した。

**確立したルール:**
1. `index.html` は **必ず `Edit` ツールで差分修正**する。`Write` による全体上書きは禁止。
2. 修正前に `Read` でターゲット行を確認し、`old_string` を正確に特定してから `Edit` を実行。
3. 修正箇所が5箇所を超える場合でも、1箇所ずつ `Edit` を積み重ねる。
4. 修正後は必ず `vercel dev` で画面を目視確認してからデプロイ。

**再発防止チェック（修正前に必ず問う）:**
- [ ] `Write` ではなく `Edit` を使おうとしているか？
- [ ] `old_string` はファイル内でユニークか？
- [ ] 修正後にローカルで目視確認できる環境があるか？

---

### KBL-002：未定義関数の呼び出し放置（2026-03-17）

**何が起きたか:**
`postChat()` が HTML から呼び出されていたが、JavaScript に実装がなく、
チャット画面の「投稿」ボタンを押すと `ReferenceError` が発生していた。

**根本原因:**
HTML の `onclick` 属性と JS の関数定義が別々に追加され、対応チェックがなかった。

**確立したルール:**
1. 新規 `onclick="xxx()"` を HTML に追加したら、**必ず同セッション内で JS 実装を確認**する。
2. 新画面・新ボタンを追加する際は「このボタンは何を呼ぶか」「その関数は存在するか」を門番視点でチェック。
3. `Grep` で `onclick=` を検索し、未定義関数がないかをデプロイ前に確認する。

---

## 外部検索・調査ツール

### 現在利用可能なツール

| ツール | 用途 | 状態 |
|--------|------|------|
| `WebSearch` | 技術ドキュメント・最新動向の検索 | ✅ 組み込み済み（Claude Code built-in） |
| `WebFetch` | 特定URLのドキュメント・仕様書の取得 | ✅ 組み込み済み（Claude Code built-in） |
| Brave Search MCP | 高精度ウェブ検索（オプション） | ⚙️ 要設定（下記参照） |

### Brave Search MCP のセットアップ（オプション）

より高精度な検索が必要になった場合は以下で追加できる：

```bash
# 1. Brave Search API キーを取得
#    https://brave.com/search/api/ でフリープランに登録

# 2. ~/.claude/settings.json に追記
```

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "YOUR_BRAVE_API_KEY"
      }
    }
  }
}
```

```bash
# 3. Claude Code を再起動して反映
```

### 自律調査のルーチン

技術的な判断が必要な場合は以下の順序で調査する：
1. `WebSearch` で最新ドキュメント・ベストプラクティスを検索
2. `WebFetch` で公式ドキュメントの該当ページを取得
3. 調査結果をユーザーに提示し、実装方針を確認してから着手

---

## 監視・自律運用ルール（自律型開発フェーズ）

このセクションは Claude Code が「監視塔」として自律的に動く際の行動規範。

### 1. ランタイム監視（監視塔）

- 開発セッション開始時に `vercel logs --follow` をバックグラウンドで起動する。
- ログ出力に以下のパターンを検知したら即座に原因を特定・報告すること：
  - `Error:` / `TypeError:` / `ReferenceError:` / `500` ステータス
  - `FUNCTION_INVOCATION_FAILED` / `MODULE_NOT_FOUND`
  - Redis 接続エラー（`UPSTASH_` 関連）/ OneSignal 送信失敗
- エラー検知時のアクション順序：
  1. エラーメッセージとスタックトレースを貼り付けて原因を日本語で説明
  2. 修正コードを提示（修正前に「何を変えるか」を説明）
  3. ユーザー承認後に `vercel --prod` でデプロイ

### 2. 開発フロー（デフォルトルーチン）

コード修正が発生するすべての作業で以下の順序を厳守する：

```
1. 修正内容を日本語で説明（何を・なぜ変えるか）
2. ファイル編集（Edit ツール）
3. ローカル確認（vercel dev が起動中であれば curl / ブラウザで動作確認を促す）
4. エラーなし確認後 → vercel --prod でプロダクションデプロイ
5. デプロイ完了 URL を報告
```

- `vercel dev` が未起動の場合は、修正前にバックグラウンドで起動する。
- ローカルテストは `curl -s http://localhost:3000/api/<endpoint>` で API を叩いて確認する。

### 3. Vercel Toolbar フィードバック対応

- ユーザーから「フィードバックを確認して」と言われたら `vercel inspect <url> --logs` で直近のデプロイ状態を確認する。
- 未対応フィードバックが存在する場合は、優先度（Critical / Minor）を付けて修正案を提示する。
- フィードバック対応後も必ずデプロイまで完結させる。

### 4. デプロイ判断基準

| 状態 | アクション |
|------|-----------|
| CSS / HTML の見た目のみの変更 | ローカル目視確認後、即デプロイ可 |
| JS ロジック変更 | `vercel dev` でブラウザ動作確認必須 |
| API (`api/*.js`) 変更 | curl でエンドポイント疎通確認必須 |
| 環境変数の追加・変更 | `vercel env add` で設定後にデプロイ |

### 5. 禁止事項

- ローカル未確認のまま `vercel --prod` を実行しない。
- エラーが出たままデプロイしない。
- `--no-verify` フラグは使用しない。
