/**
 * RE-EYE-HUB プラン設定
 *
 * 現フェーズ: 単一オーナー運用
 * CURRENT_PLAN は全システム共通の「デフォルトプラン」としてハードコード。
 * 将来マルチユーザー化する際は Redis user:plan:{userId} で上書きする。
 */

// ── システムデフォルトプラン ────────────────────────────────
export const CURRENT_PLAN = 'VIP';

// ── Stock Watch ─────────────────────────────────────────────
//   テスト中: インターバル実質無効（checkAllWatched は elapsed >= 0 で常に対象）
//   dayInterval  : 昼間（08:00–19:00）の監視間隔（秒）
//   nightInterval: 夜間の監視間隔（秒）null = スキップ
//   jitterSec    : ±揺らぎ秒数（0 = 揺らぎなし）
/** 在庫監視のベース間隔（秒）。0 のときプラン別も 0 扱いで待ちなし。 */
export const DEFAULT_MONITOR_INTERVAL_SEC = 0;

export const STOCK_CONFIG = {
  FREE:     { dayInterval: 3600, nightInterval: null,  jitterSec: 0  },
  STANDARD: { dayInterval: 900,  nightInterval: 3600,  jitterSec: 0  },
  PRO:      { dayInterval: 300,  nightInterval: 3600,  jitterSec: 60 },
  VIP:      { dayInterval: 300,  nightInterval: 300,   jitterSec: 60 },
};

// ── Scout ────────────────────────────────────────────────────
//   intervalSec: スカウト巡回間隔（秒）
//   mode       : 巡回深度（ルールベース・外部 AI 不使用）
export const SCOUT_CONFIG = {
  FREE:     { intervalSec: 0, mode: 'summary' },
  STANDARD: { intervalSec: 0, mode: 'rss' },
  PRO:      { intervalSec: 0, mode: 'rss_deep' },
  VIP:      { intervalSec: 0, mode: 'vip_full' },
};

// ── Trend ────────────────────────────────────────────────────
//   slots    : 同時監視枠数
//   heuristic: 表示用ラベル（フロント／将来のヒューリスティック用）
export const TREND_CONFIG = {
  FREE:     { slots:  3, heuristic: 'confirmed_only'  },
  STANDARD: { slots:  5, heuristic: 'flag_priority'   },
  PRO:      { slots:  5, heuristic: 'ambiguous_parse' },
  VIP:      { slots: 10, heuristic: 'future_predict'  },
};

// ── ヘルパー ──────────────────────────────────────────────────

/**
 * Jitter（揺らぎ）付き待機
 * @param {number} baseSec   ベース待機秒数
 * @param {number} jitterSec ±揺らぎ幅（秒）。0 なら揺らぎなし
 * @returns {Promise<void>}
 */
export function jitterWait(baseSec, jitterSec = 0) {
  const delta = jitterSec > 0
    ? Math.floor(Math.random() * jitterSec * 2) - jitterSec
    : 0;
  const ms = Math.max(0, (baseSec + delta) * 1000);
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 現プラン（CURRENT_PLAN）の Stock Watch インターバルを返す。
 * @param {number} [nowHour] 0–23。省略時は現在時刻。
 * @returns {{ intervalSec: number|null, jitterSec: number }}
 *          intervalSec が null の場合はスキップ指示。
 */
export function getStockInterval(nowHour = new Date().getHours()) {
  const cfg = STOCK_CONFIG[CURRENT_PLAN] ?? STOCK_CONFIG.FREE;
  const isDay = nowHour >= 8 && nowHour < 19;
  return {
    intervalSec: isDay ? cfg.dayInterval : cfg.nightInterval,
    jitterSec:   cfg.jitterSec,
  };
}

/**
 * 指定プランの Stock Watch インターバルを返す（アイテム別プラン対応）。
 * @param {string} plan  'FREE'|'STANDARD'|'PRO'|'VIP'
 * @param {number} [nowHour]
 * @returns {{ intervalSec: number|null, jitterSec: number }}
 */
export function getStockIntervalForPlan(plan, nowHour = new Date().getHours()) {
  const cfg = STOCK_CONFIG[plan] ?? STOCK_CONFIG.FREE;
  const isDay = nowHour >= 8 && nowHour < 19;
  return {
    intervalSec: isDay ? cfg.dayInterval : cfg.nightInterval,
    jitterSec:   cfg.jitterSec,
  };
}

/**
 * 現プランの Trend スロット数を返す。
 */
export function getTrendSlots() {
  return (TREND_CONFIG[CURRENT_PLAN] ?? TREND_CONFIG.FREE).slots;
}

/**
 * Adaptive Monitoring — エントリの熱量・モードに応じた間隔乗数を返す。
 *
 * 乗数設計:
 *   0.5 × : 直近1時間以内に通知済み（hot item — 追跡中）
 *   1.0 × : 通常（sneaker mode または recent activity あり）
 *   2.0 × : standard mode で変化なし（軽量HTML監視で十分）
 *   4.0 × : 7日以上変化なし かつ 一度も通知なし（cold item — 低頻度でOK）
 *
 * 目的: Redis コマンド数削減 + Vercel Serverless CPU 削減。
 *       変化のないアイテムにリソースを使わない。
 *
 * @param {{ mode?: string, notifiedAt?: number, lastCheckedAt?: number, addedAt?: number }} entry
 * @returns {number} 乗数（0.5 〜 4.0）
 */
export function getAdaptiveIntervalMultiplier(entry) {
  const now      = Date.now();
  const notified = entry.notifiedAt  || 0;
  const added    = entry.addedAt     || now;

  // 直近1時間以内に通知済み → 高頻度で追跡（抽選結果・再販連続チェック用）
  if (notified > 0 && now - notified < 60 * 60 * 1000) return 0.5;

  // 7日以上登録されているのに一度も通知なし → cold item
  const ageSec = (now - added) / 1000;
  if (ageSec > 7 * 24 * 3600 && notified === 0) return 4.0;

  // standard mode（ちいかわ/コスメ等）は PDP 不要 → 通常の2倍インターバルで十分
  if (entry.mode === 'standard') return 2.0;

  return 1.0;
}
