# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚡ 最優先事項：V11 リサーチ起点型 SERP 監視アーキテクチャ（2026-04-14）

> **「URL を番犬のように見張るな。検索結果ページ（SERP）を見張れ。」**
> これが V11 の核心。特定 URL の死活監視から脱却し、SERP 差分検知で「新しく出た店」を自動発見する。

### 基本思想

旧来の「在庫URL → HTTP ポーリング → IN/OUT 判定」では永遠に取りこぼしが発生する。
なぜなら「今まで存在しなかった店舗 URL」は監視リストにそもそも存在しないからだ。

V11 では **SERP そのものを監視対象** にする：
1. 4軸クエリ（品番 + 色 + サイズ + 性別）を生成して楽天・Yahoo・Google Shopping を叩く
2. 前回の SERP URL セット (`entry.serpUrls`) と今回の URL セットを diff する
3. **新しく出現した URL** が「新着在庫シグナル」
4. 新着 URL を 4軸 AI（`aiItemVerify()`）で最終確認してから通知する

### 4軸クエリ生成フロー

```
keyword
  └→ expandColorQuery()         // 水色 → 水色 ライトブルー celeste
  └→ generateVibeQueries()      // Gemini が品番・色日英・cm/US サイズ・在庫意図語を最適合成
  └→ searchAll() + searchGoogleShopping()  // 楽天・Yahoo・Google に並列投射
```

**禁止事項:** `expandColorQuery()` の呼び忘れ厳禁。色同義語展開なしのクエリは「半盲」。

### serpUrls 差分検知

```
prev = entry.serpUrls ?? null
  ↓  null の場合: 初回ベースライン（通知なし、serpUrls だけ記録）
  ↓  Set あり:
     newUrls = currentUrls.difference(prev)  ← これが新着シグナル
     if newUrls.size > 0 → 新着店舗の在庫確認へ
```

- `entry.serpUrls` は Redis の `monitor:watched:{userId}` 内に JSON Set として保存
- 毎サイクル上書き（前回分は捨てる）

### 4軸 AI 最終確認（`aiItemVerify()`）

新着 URL のタイトルに対して Gemini が以下 4 軸を同時検証：

| 軸 | チェック内容 |
|----|------------|
| 品番 | ハイフン以下含む完全一致（例: CW2288-111） |
| 色 | 水色=Celeste=light blue 等を同一視 |
| サイズ | US/cm/mm 表記ゆれ吸収（±0.5cm 許容） |
| 性別 | Women's/レディース/Men's/メンズを文脈判定 |

**「どれ一つ欠けてもゴミ」— `pass: false` なら通知しない。**

### プラン別リサーチ間隔

| プラン | Cron 起動 | 実行条件 | 実効間隔 |
|--------|----------|---------|---------|
| VIP    | 毎1分    | `intervalSec: 300` (5分) + Jitter ±60s | 4〜6分 |
| PRO    | 毎1分    | `intervalSec: 300` (5分) + Jitter ±60s | 4〜6分 |
| STANDARD | 毎1分  | `intervalSec: 900` (15分) | ~15分 |
| FREE   | 毎1分    | `intervalSec: 3600` (昼のみ) | ~60分 |

Cron は `every 1 minutes` で毎分起動するが、`checkAllWatched()` 内の `getStockIntervalForPlan()` が
「前回実行からプラン規定秒数が経過したアイテムのみ」を処理することで実効間隔を制御する。

### 公式ドメイン特権パス（`checkOfficialAndNotify()`）

`OFFICIAL_DOMAINS`（nike.com, coach.com 等）に一致する URL は SERP 監視をバイパスし、
直接 HTTP フェッチ → 2軸ステート（officialStatus + marketStatus）管理 → カスケード検索 に進む。

### 実装ファイルマップ

| 責務 | ファイル |
|------|---------|
| SERP 監視メインループ | `api/monitor.js` → `checkAndNotifySerp()` |
| 公式直接フェッチ | `api/monitor.js` → `checkOfficialAndNotify()` |
| 4軸 AI 検証 | `lib/ai-extractor.js` → `aiItemVerify()` |
| Vibe クエリ生成 | `lib/ai-extractor.js` → `generateVibeQueries()` |
| 色同義語展開 | `lib/color-filter.js` → `expandColorQuery()` |
| Google Shopping | `lib/google-shopping.js` → `searchGoogleShopping()` |
| プラン別間隔 | `lib/plan-config.js` → `getStockIntervalForPlan()` |
| Cron 起動 | `index.js` → `stockWatchScheduler`（every 1 minutes） |

---

## コマンド

```bash
# 依存インストール
npm install

# ローカル開発（Firebase エミュレータ起動）
firebase serve
# または（Hosting + Functions を同時に立ち上げる場合）
firebase emulators:start

# Firebase へデプロイ
firebase deploy

# Hosting のみデプロイ（フロントのみ変更時）
firebase deploy --only hosting

# Functions のみデプロイ（API 変更時）
firebase deploy --only functions
```

テストフレームワークは未導入。動作確認は README.md の curl 例で行う。

## アーキテクチャ概要

このプロジェクトは **2層構造**になっている。

### 層1：バックエンド通知エンジン（`api/` + `lib/`）

Firebase Cloud Functions v2（Node.js 20、ESM）で動作する API 群。Express で単一の `onRequest` にまとめ、`index.js` がエントリーポイント。
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
- `intel:seen:<sha256>` — スカウター重複排除フラグ（TTL **60日**）

**Firebase Hosting rewrite:**
`/api/**` → Cloud Function `api`（`asia-northeast1`）にルーティング。`firebase.json` で設定済み。

---

## インテル・スカウター仕様（`api/scout.js` + `lib/rss-scanner.js`）

> **「24時間」という言葉はこのシステムに存在しない。索敵深度は常に60日。**

### Deep Recon: 60 Days（索敵深度の公式スペック）

- Google News RSS に `&when=2m` パラメータを付与し、**過去60日間（2ヶ月）**の記事を対象に巡回する
- Redis 重複排除 TTL も 60日（`DEDUP_TTL_SEC = 60 * 24 * 60 * 60`）に合わせて延長
- UI 上は探索画面に `◈ Deep Recon: 60 Days` ラベルを常設してスペックを明示する
- 「24時間制限」「24時間以内」という表現は使用禁止。常に「過去60日間」で統一する

### 多弾頭スキャン（キーワード自動展開）

`api/scout.js` の `expandKeywords(seeds)` が、**スペースなしの単体ブランド名**に対して以下を自動付加：

```
"ヴィトン" → ["ヴィトン", "ヴィトン 新作 限定", "ヴィトン 予約 発表"]
```

- 複合キーワード（スペースあり）は展開しない
- 展開後の上限は `MAX_EXPANDED = 8` クエリ
- スケジューラーとオンデマンド両方で同じ展開ロジックを使用する

### 足跡（Footprint）と予兆（Intel）の分離

`scanKeyword()` は Redis 重複排除**前**の総ヒット数 `totalFromFeed` を返す。`scanAll()` がこれを集計して `totalFoundInFeed` としてレスポンスに含める。

フロントの `runIntelScout` はこれを使って**誠実な報告**を行う：

| 状態 | ユーザーへの表示 |
|------|----------------|
| `items.length > 0` | 記事カードをインライン表示 + 履歴タブへ自動遷移 |
| `items.length === 0` かつ `totalFoundInFeed > 0` | 「過去60日間の足跡を検知。ハントの参考にしてください」 |
| `items.length === 0` かつ `totalFoundInFeed === 0` | 「過去60日間の深層スキャンを完了。予約・新作の有力な予兆は検知されませんでした。24H哨戒を継続します」 |

### 未来日付解析エンジン（`parseFutureDate`）

`public/index.html` 内の `parseFutureDate(text)` がタイトル・本文テキストから発売予定日を抽出する。

| 入力パターン | 変換例（現在日 2026-03-31 基準） |
|-------------|-------------------------------|
| `4月15日` | `4/15 発売予定` |
| `4月` | `4/1 発売予定` |
| `来週` | `4/7 発売予定` |
| `来月` | `4/1 発売予定` |
| `春` | `4/1 発売予定` |
| `夏` | `7/1 発売予定` |

- 優先順位: 本文日付解析 → `pubDate`「情報更新」フォールバック
- 過去日付はスキップし、翌年に繰り越す

### 公式直結弾頭（Official Site Queries）

> **禁止事項：`site:amazon.co.jp` 等の `site:` 演算子は Google News RSS で動作しない（空結果を返す）。絶対に使うな。**
> 代替：「店名・ブランド名」を複合クエリとして付加する。Google News で確実に動く唯一の方法。

`expandKeywords()` は単体キーワードに対して最大 `MAX_EXPANDED = 10` クエリを生成：

```
"ポケモン" → [
  "ポケモン",
  "ポケモン 新作 限定",
  "ポケモン 予約 発表",
  "ポケモン 在庫 再販",
  "ポケモン 入荷 最新情報",
  "ポケモン ポケモンセンター",   ← CATEGORY_DOMAINS テーブルから
  "ポケモン バンダイ",
]

"おもちゃ" → [
  "おもちゃ", "おもちゃ 新作 限定", "おもちゃ 予約 発表",
  "おもちゃ 在庫 再販", "おもちゃ 入荷 最新情報",
  "おもちゃ バンダイ", "おもちゃ タカラトミー", "おもちゃ アミアミ",
]
```

`api/scout.js` の `CATEGORY_DOMAINS` テーブルにキーを追加して「聖地」を拡張できる。

### 超速報ロジック（Newest-First Sort）

`scanKeyword()` は newItems を `pubDate` 降順でソートして返す。最新記事が常にリスト先頭に来る。

### 在庫復活・品切れ監視（`lib/stock-checker.js` + `POST /api/stock`）

**エンドポイント:** `POST /api/stock`
**リクエスト:** `{ targets: [{ url: "https://...", keyword?: "..." }] }`（最大5件）
**レスポンス:** `{ results: [{ status, url }], errors, checkedAt }`

`status` の値：

| 値 | 意味 |
|----|------|
| `in_stock` | 在庫あり（「カートに入れる」等のパターン検知） |
| `out_of_stock` | 品切れ（「品切れ」「sold out」等のパターン検知） |
| `unknown` | パターン不一致（ページ構造が非対応） |
| `error` | フェッチ失敗 |

- `https://` から始まる URL のみ受け付ける（バリデーション済み）
- ステルスヘッダー（`lib/stealth.js`）を使用してボット検知を回避
- `lib/stock-checker.js` の `IN_STOCK_PATTERNS` / `OUT_OF_STOCK_PATTERNS` に新しいショップのパターンを追加して拡張する

### 定価超過バッジ（OVER LIST PRICE）

`trendItem.overListPrice === true` の場合、カードにシャンパンゴールドの `.over-list-badge` を表示：

```
OVER LIST PRICE（定価超過）
```

- 市場価格 $P_{market} > P_{list}$（定価）の判定フラグ
- バッジ表示時はユーザーに無駄な張り込みをやめさせる「慈悲の通知」として機能する

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

- ログ出力に以下のパターンを検知したら即座に原因を特定・報告すること：
  - `Error:` / `TypeError:` / `ReferenceError:` / `500` ステータス
  - `FUNCTION_INVOCATION_FAILED` / `MODULE_NOT_FOUND`
  - Redis 接続エラー（`UPSTASH_` 関連）/ OneSignal 送信失敗
- エラー検知時のアクション順序：
  1. エラーメッセージとスタックトレースを貼り付けて原因を日本語で説明
  2. 修正コードを提示（修正前に「何を変えるか」を説明）
  3. ユーザー承認後に `firebase deploy` でデプロイ

### 2. 開発フロー（デフォルトルーチン）

コード修正が発生するすべての作業で以下の順序を厳守する：

```
1. 修正内容を日本語で説明（何を・なぜ変えるか）
2. ファイル編集（Edit ツール）
3. ローカル確認（firebase emulators:start が起動中であれば curl / ブラウザで動作確認を促す）
4. エラーなし確認後 → firebase deploy でプロダクションデプロイ
5. デプロイ完了 URL（https://re-eye-hub.web.app）を報告
```

- ローカルテストは `curl -s http://localhost:5001/re-eye-hub/asia-northeast1/api/<endpoint>` で API を叩いて確認する。

### 3. デプロイ判断基準

| 状態 | アクション |
|------|-----------|
| CSS / HTML の見た目のみの変更 | `firebase deploy --only hosting` |
| JS フロントのロジック変更 | `firebase deploy --only hosting` |
| `api/*.js` / `lib/*.js` 変更 | `firebase deploy --only functions` |
| 両方変更 | `firebase deploy`（フル） |
| 環境変数の追加・変更 | `.env` を更新後に `firebase deploy --only functions` |

### 4. 禁止事項

- エラーが出たままデプロイしない。
- `--force` フラグは使用しない。
- `index.html` を `Write` ツールで全体上書きしない（KBL-001 参照）。
