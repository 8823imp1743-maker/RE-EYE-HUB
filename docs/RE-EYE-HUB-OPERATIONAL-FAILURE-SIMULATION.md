# RE-EYE-HUB：現場破壊シミュレーション（運用完了のための地図）

**位置づけ:** 仕様（[FINAL LOCK SPEC](./RE-EYE-HUB-FINAL-LOCK-SPEC.md)）ではなく、**時間が経つと必ず起きる故障と観測のための一覧**。  
コアを変えずに「どこを見れば終わったと言えるか」を固定する。

---

## 1. 外部依存の単体障害

| 事象 | 症状 | まず見るログ・指標 | 許容・対処の考え方 |
| --- | --- | --- | --- |
| SERP API 障害・レート制限 | 新着ゼロ、検索エラー文字列 | `monitor` outcome・`searchAllCached` エラー配列 | 一時的サイレント。ユーザー文言で「検索 API エラーあり」を出せているか |
| Gemini 障害・キー無効 | ヒューリスティック分類のみ | `classifierNote`・`[serp-classifier]` warn | キー復旧まで精度低下。運用でキーローテ検知 |
| Upstash 障害 | 監視・browse 503、学習停止 | `[redis]` retry・503 レスポンス | 短時間なら許容。長時間は通知・digest も止まる |
| OneSignal 障害 | PDP OK だがプッシュ無し | `notification_send_fail` ops ログ | ユーザーはアプリ内履歴で救済できる設計か確認 |
| 対象 DOM 変更 | `dom_structural` 急減、unknown 増 | PDP `reason` 分布・ホスト別 | **最頻の現場破壊**。パターン追加は `pdp-shoe-stock` 側の「実装」であり仕様 v1.0 の外で反復する |

---

## 2. データ・学習ループの病理

| 事象 | 症状 | 検知 | 対処の方向 |
| --- | --- | --- | --- |
| **false reject 蓄積** | CE reject 増、通知減 | `ce:fb:flagcounts` の偏り・フラグ上位 | プロンプトが過度に保守的。フラグ別にサンプル URL を人手レビュー |
| **feedback 偏り** | 特定ホストだけフラグ突出 | `ce:fb:recent` の host 分布 | ドメイン別ノイズの可能性。ルール追加はコードだが「観測結果」が先 |
| Redis キー肥大 | 遅延・コスト | Upstash メトリクス | CE キーは TTL 済み。別機能キーの TTL 監査 |

---

## 3. 同時多発・レース

| 事象 | 症状 | 検知 |
| --- | --- | --- |
| 同一 URL へ監視多重 | 重複通知・Redis 競合 | dedupe キー hit 率 |
| browse キャッシュと監視のズレ | 画面と通知の不一致 | `browseCacheKey` 世代・refresh パラメータ |
| cron 重複起動 | 二重 PDP | 同一 `userId+hash` の短時間 `lastCheckedAt` |

---

## 4. 公式ルート固有

| 事象 | 症状 | メモ |
| --- | --- | --- |
| 公式 DOM の A/B | structuralOk フラップ | SERP 系と **別ファイル**で追う（`checkOfficialAndNotify`） |
| カスケードのみ成功・PDP 失敗 | 市場 FOUND だが通知なし | 仕様通り（通知は PDP） |

---

## 5. 「運用で終わった」と言える最低条件（提案）

次が満たせれば、**仕様以外の完了**に近い：

1. **週次:** `ce:fb:flagcounts` 上位 3 フラグを記録（スプレッドシートでよい）
2. **アラート:** Redis / Functions の 5xx を 1 チャネルに集約（メール or Slack 1 本でよい）
3. **四半期:** PDP `reason` のホスト別集計から「DOM 変化候補」を 1 リスト化

---

## 6. 一文

**コアは凍結済み。** 現場で壊れるのは **外部と時間** なので、終わらせる作業は **観測とリストの継続** だけである。
