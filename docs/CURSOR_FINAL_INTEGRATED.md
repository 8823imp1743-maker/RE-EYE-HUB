# RE-EYE-HUB：完全統合・最終運用指示書（Cursor にそのまま貼る）

**目的：** ユーザー指定サイズの商品を「低コスト・高精度・誤判定最小・通知抑制」で回す。**曖昧な `html.includes(cm)`／meta依存／カートのみ判定／全件 PDP は禁止。**

---

## 〇 現在のソース・オブ・アトゥール（コードベース状態）

以下はリポジトリに **実装済み** とみなせる：

| 領域 | 実装内容 |
|------|----------|
| PDP 本体 | `functions/lib/pdp-shoe-stock.js` — **`analyzePdpHtmlForShoeCm`（構造解析）維持**、レンジ除外、楽天 script/includes 補助は仕様どおり。**fetch 失敗＝`ok:null`（在庫不明）**。 |
| キャッシュ | L1 `Map`（約5分）、L2 Redis `pdp:cache:{sha256(url)}:{cm}` TTL300s、`inFlight` で同一 `(url,cm)` 集約。**`normalizeRakutenUrl` でアフィ展開・追跡クエリ除去（バリエーション用クエリは残す）。** |
| 検索 | `functions/api/search.js` — 候補は捨てずスコア再ソート。`FREE` は PDP 禁止・`ok:null`。`STANDARD` は **上位3 PDP**、`PRO`/`VIP` は **上位6 PDP**。**並列3**。検証 Throw は **`ok:null`**。 |
| 監視通知 | SERP 新着送信前に **`SET … NX + EX600`** で重複除去。Redis キーは `notify:sent:{userId}:{ハッシュ短縮}`（長いモール ID 対策）。**JST 21:00〜09:00 は `checkAllWatched` 全体スキップ**（`MONITOR_JST_QUIET_DISABLED=1` でオフ）。 |
| サイズ補助 | `functions/lib/size-engine/` — ターゲット cm 配列 (`resolveCmTargetsForProfile`)・一覧距離ティア (`haystackCmGapTierBonus`)・服アルファ別処理 (`apparelAlphaGapBonus`)。PDP は `analyze…` が **複数ターゲット ANY**。 |
| ログ | `RE_EYE_PDP_LOG=1` で軽量 `log:size:…`（既定オフ）。 |
| UI | `ok===true` 在庫あり / `ok===null` 確認中 / `ok===false` 見え方は仕様通り確認 |

**単体テスト：** リポジトリ直下 `npm test`（PDPレガシーガード＋`node --test lib/pdp-shoe-stock.test.mjs`）

---

## 〇 開発原則（壊さない順）

1. **`analyzePdpHtmlForShoeCm` と構造選択子の意味を変更しない。** 単純正規現の `includes` に置換しない。
2. **PR 単位：** Redis／検索 PDP 上限／監視タイミング は別コミット可。
3. **変更後は必ず `npm test`。** fetch 失敗＝`ok:null` にテスト整合。

---

## 〇 PDP コスト防衛チェックリスト

- [ ] `FREE` が PDP を実行していない（レスポンス `pdpSizeCheck.ok === null`、`pdp_calls=0`）
- [ ] `STANDARD` の PDP が **最大3**/リクエスト
- [ ] `PRO/VIP` の PDP が **最大6**/リクエスト  
- [ ] 同一 PDP が 5分以内に二重 fetch されない（L1+L2）
- [ ] `fetch timeout` が短い（例 3000ms）

---

## 〇 運用（Firebase / Cron）

| 環境変数 | 役割 |
|----------|------|
| `UPSTASH_REDIS_REST_*` | PDP L2／通知ロック／ユーザー plan（必須） |
| `MONITOR_JST_QUIET_DISABLED=1` | 静粭時間ウィンドウを無効に（デバッグ・緊急） |
| `RE_EYE_PDP_LOG=1` | サイズ判定サンプルを Redis に書く |

---

## 〇 収益・ビジネス（コード外）

- アフィリンクはモール側成果タグ運用。**アプリ内で PDP を増やして踏みに行く設計にはしない。**  
- FREE は広告・アフィのみ／有料プランで広告オフなどは **フロントと課金基盤**で統一。

---

## 〇 明示的に「まだしない」リスト（暴走防止）

| 項目 | 理由 |
|------|------|
| モール検索結果の **`search:cache:{query}` 全ページキャッシュ** | キーワード展開・鮮度と噛み合わせないと陳腐化・誤表示 |
| **ブランド補正の自動適用で cm を常にずらす** | 誤学習が致命傷。ログ蓄積＋人手レビュー後に限定 |
| **PDP で Amazon スクレイピング常時** | ToS／ブロック確率 |

---

## 〇 一文結論

**ここまでで「開発は収束線」／次は TTL・PDP上限・検索ウィンドウをログ見て調整するだけ。**
