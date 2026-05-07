# RE-EYE-HUB FINAL LOCK SPEC（v1.0 / FULL FREEZE）

---

## 文書状態

本仕様は **コアアーキテクチャの凍結定義** である。

- ここに書かれた構造は **意図的に改めない**
- 変更する場合は **v1.1 以上**の別改訂（プロダクト判断）
- 「実装の微修正」と「仕様改訂」を混同しない

---

## 完成の評価（「100点以上？」への答え）

- **仕様レイヤ**では、コア責務（SERP→LLM→PDP→CE→学習→UI）は **出し切った** とみなす。ここに点数を足しても意味は増えない。
- **100点満点「以上」**をコードと文書だけで保証することはできない。残差は **運用・時間・DOM/SERP/モデルの外部世界** に移る。
- 「まだ未完成に感じる」場合の典型原因は **仕様欠けではなく**（①現場可視化が薄い ②実データの蓄積が浅い）のどちらかである。

---

# 0. 結論（このシステムの定義）

RE-EYE-HUB は以下として **完成** している：

> SERP（ノイズ）を入力として受け取り  
> LLM で仮説化し  
> PDP で物理的真偽のみを確定し  
> CE で矛盾を除去し  
> Redis で誤りを蓄積して次回補正する  
> **実体検証フィルターエンジン**

検索システムではない。

---

# 1. 全体構造（絶対固定）

```
SERP → LLM → Classification → PDP → CE → Decision → Redis → UI
```

- **Decision:** 最終採用・通知可否・状態更新（`isSerpV5FinalStockOn` 等）。
- **Redis（CE 以外のキー）:** 監視状態・browse キャッシュ等も含むが、**学習の意味での「誤りの記憶」**は CE reject 系キーに限定して語る。
- **時系列:** CE 由来のプロンプト補正は主に **次回**の LLM バッチに効く。

**公式 URL ルート**は下記「独立ルート」。この 1 本の図には **含めない**（混線防止）。

---

## 真実の定義（これ以上の意味付け禁止）

| レイヤ | 意味 |
| --- | --- |
| SERP | 候補（嘘混じり） |
| LLM | 仮説（揺れる） |
| PDP | **物理真実** |
| CE | **矛盾検査**（最終ゲート） |
| Redis | **記憶**（判定主体ではない） |

---

# 2. 4層モデル

| 層 | 役割 | 信頼度 |
| --- | --- | --- |
| SERP | 候補データ（ノイズ前提） | 低 |
| LLM | 仮説生成 | 中 |
| PDP | 物理真実判定 | **最高** |
| CE | 矛盾検出・排除 | **最終ゲート** |

Redis・UI はこの外周（記憶・表示）であり、**物理真偽の確定権を持たない**。

---

# 3. SERP ルール（絶対）

- SERP は真実として扱わない
- 在庫判断禁止
- 価格判断禁止（SERP 層での確定禁止）
- 最大 **10 件**のみ処理
- **ループ処理**（先頭10の収集は `slice` 依存禁止の設計思想＝**loop + break**）

**境界:** 応答のページング等でリストに `slice` があっても、**SERP 生10件の収集規則**とは別レイヤ。

---

# 4. LLM 出力スキーマ（固定）

```json
{
  "category": "shoe | clothing | sticker | bag | cosmetics | other",
  "product_role": "main | accessory | packaging | tool | fake | unknown",
  "gender": "male | female | unisex | unknown",
  "confidence": "0.0 - 1.0"
}
```

**category は 6 語のみ。増やさない。**

---

# 5. スコアリング

```
score =
  + main(0.4)
  - accessory(0.6)
  - packaging(0.7)
  - fake(1.0)
  + confidence
  + gender_adjustment
```

## 採用条件

```
score >= 0.6
```

（パイプライン入口。PDP 発火は別ルール。）

---

# 6. PDP（物理真実層）

## 定義

- DOM ベースの構造判定
- **在庫・存在・購入導線**のみを物理層として扱う

## 発火条件（意味の凍結）

- **shoe** → cm or shoe keyword 文脈
- **clothing** → apparel or size
- **main + confidence >= 0.85** → generic PDP
- **sticker / bag / cosmetics / other** → rule-based trigger（錨一致等）

## 出力（信頼できる真）

実装では `reason === 'dom_structural'` かつ `ok`・非 tentative を **PDP true** とみなす。  
それ以外の PDP 結果は **物理真として採用しない**（`false` 扱い）。

---

## 公式 URL ルート（独立・凍結）

```text
official URL → PDP（同一 runSerpV5PdpVerify）→ 軽量ゲート（プラン・LTV・cap 等）→ 通知
（SERP / LLM / CE とは分離。LLM 行が無いため evaluateContradictionEngine は通さない）
```

`checkOfficialAndNotify`：カスケードは市場参照メタ、**通知の真理は PDP**（コメントどおり）。

---

# 7. CE（矛盾検出）

## 凍結リスト（主・これだけで「CE の心臓」）

- **fake + high confidence + PDP mismatch**（実装: `fake` かつ高 confidence × PDP on → `role_vs_pdp`）
- **accessory + PDP true**（confidence 無視・`accessory_pdp_true`）
- **packaging + PDP true**（confidence 無視・`packaging_pdp_true`）
- **gender conflict**
- **SERP strong match + PDP false**（錨一致 × PDP off 等）

## 出力

```
accept | reject | retry
```

## 実装が併せて保持する検知（縮退させない）

次も **CE に残す**（誤検知抑制のため主リストと併存）：

- LLM 高 confidence × PDP off（過信フラグ）
- `shoe` × PDP off（構造矛盾フラグ）
- PDP fetch 再試行可能 → `retry`

## 特に重要ルール（LOCK）

```
product_role = accessory AND PDP = true → 必ず reject
product_role = packaging AND PDP = true → 必ず reject
```

## PDP 未発火

- `finalAdopted = false`・CE 上は **`no_pdp_arm`** で明示
- 候補表示には残りうるが **最終採用ではない**
- Redis 学習ログには **載せない**

---

# 8. Feedback Loop（運用学習）

## 処理フロー

```
CE reject
  → Redis 保存
  → 集計
  → 次回 LLM プロンプトへ注入
```

## 保存内容

- keyword prefix
- host
- source
- flags

※**タイトル全文禁止**（ノイズ・PII 抑制）

## Redis（実装キー）

- `ce:fb:recent` — 直近イベント（最大 **200** 件相当・**90 日** TTL）
- `ce:fb:flagcounts` — フラグ別回数（**90 日** TTL）

---

# 9. キャッシュ

| 種類 | TTL |
| --- | --- |
| SERP（監視・browse 内の明示呼び出し） | **120s** |
| browse 結果 Redis | **180s**（環境変数で上書き可） |
| PDP success | **120s** |
| PDP fail | **15s** |

---

# 10. UI 構造

- SERP 一覧
- スコア表示
- PDP 結果
- CE reject 表示
- **最終採用状態**

---

# 11. 外部依存

- SERP API
- Gemini
- Redis
- DOM 構造
- 通知サービス（OneSignal）

---

# 12. 完成条件（結論）

## 完成済み（仕様・コア）

- 4 層分離（SERP / LLM / PDP / CE）
- 物理真実の定義（PDP）
- 矛盾排除（CE）
- 学習ループ（Redis feedback）
- **official 分離**（上記独立ルート）
- fake / accessory / packaging / gender 制御

## これ以上やると「仕様」ではなく別領域になるもの

- UI 改善
- 運用監視・ダッシュボード
- スケール設計
- データ分析・SLA

**仕様として追加すべきものはない**（要望が出たら v1.1 かプロダクトバックログ）。

---

## 関連：現場破壊の想定

コア完了後に効く **運用シミュレーション**（壊れ方の地図）:  
[RE-EYE-HUB-OPERATIONAL-FAILURE-SIMULATION.md](./RE-EYE-HUB-OPERATIONAL-FAILURE-SIMULATION.md)

---

# 13. リスク

- SERP 構造変更
- DOM 崩壊
- LLM モデル揚れ
- Redis 肥大化
- false reject 蓄積

---

# 14. 本質

> RE-EYE-HUB は検索ではない  
> SERP の誤認識を物理構造で削除する装置である

---

# 15. 評価（現在地）

| 領域 | 評価 |
| --- | --- |
| コア設計 | 100 |
| 実装 | 95 |
| 防御 | 95 |
| 運用 | 80 |
| 可視化 | 75 |

---

# 16. 最終状態

このシステムは：

> 「正解を当てる AI」ではなく  
> **「誤りを構造的に削除し続けるフィルター」** である

---

# 17. END OF SPEC（凍結）

この仕様は **v1.0** として凍結される。

- 変更は **v1.1 以上**の改訂扱い
- 実装改善だけで済ませない変更は **プロダクト変更**
- これ以上は **運用フェーズ**（観測・UX・SLA 領域）

---

# 18. 付記（実装との整合）

- **accessory + PDP true** → reject（実装一致・`accessory_pdp_true`）
- **packaging + PDP true** → reject（実装一致・`packaging_pdp_true`）
- CE feedback → Redis（実装一致）
- **clothing** 含む **6 カテゴリ**固定（実装一致）
- **browse** / **monitor（SERP 経路）** は同一 CE・同一 PDP パイプライン（`serp-v5-pipeline` / `contradiction-engine`）
- **公式直結（official URL）** は LLM 行が無いため **`evaluateContradictionEngine` は通さない**。`PDP → 軽量ゲート（プラン・LTV・cap）→ 通知`（`checkOfficialAndNotify`）
- slice 禁止は「最大 10 件ループ処理」として実装解釈する

---

# 最終一文

> RE-EYE-HUB は「検索システム」ではない。  
> SERP の誤認識を PDP で物理的に潰し、CE で矛盾を排除し続ける **実体抽出エンジン** である。

---

## ■ END OF SPEC（凍結 / v1.0）

---

## 付録：実装アンカー（索引のみ）

| 領域 | 主ファイル |
| --- | --- |
| 監視・browse | `functions/api/monitor.js` |
| LLM・スコア | `functions/lib/serp-product-classifier.js` |
| PDP 発火・採用列 | `functions/lib/serp-v5-pipeline.js` |
| CE | `functions/lib/contradiction-engine.js` |
| Redis 学習 | `functions/lib/ce-feedback.js` |
| PDP DOM | `functions/lib/pdp-shoe-stock.js` |
