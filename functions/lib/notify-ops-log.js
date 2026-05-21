/**
 * Cloud Logging で grep できる統一イベントログ。[re_eye_ops]
 * メトリックの完全な算出は別（BigQuery連携など）でも、送信・スキップの観測に使う。
 */

/**
 * @param {string} event
 * @param {Record<string, unknown>} payload
 */
export function opsJsonLog(event, payload = {}) {
  const line = JSON.stringify({
    ts: Date.now(),
    event,
    ...payload,
  });
  console.log(`[re_eye_ops] ${line}`);
}
