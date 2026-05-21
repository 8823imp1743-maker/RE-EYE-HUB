/**
 * Sentry エラー監視ユーティリティ（Vercel Serverless 専用）
 *
 * 設計方針:
 * - SENTRY_DSN が未設定の場合は完全にスキップ（副作用ゼロ）
 * - CRITICAL（5xx・例外）のみ capture。4xx はスコープ外
 * - flush(2000) で Vercel の関数終了前に送信を保証
 */
import * as Sentry from '@sentry/node';

let initialized = false;

function ensureInit() {
  if (initialized) return;
  const dsn = (process.env.SENTRY_DSN || '').trim();
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || 'production',
    tracesSampleRate: 0,
    integrations: [],
  });
  initialized = true;
}

/**
 * 例外を Sentry に送信する（CRITICAL 専用）。
 * SENTRY_DSN 未設定時は何もしない。
 * @param {unknown} err
 * @param {{ endpoint?: string, userId?: string }} [ctx]
 */
export async function captureIfCritical(err, ctx = {}) {
  ensureInit();
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (ctx.endpoint) scope.setTag('endpoint', ctx.endpoint);
    if (ctx.userId)   scope.setUser({ id: String(ctx.userId).slice(0, 64) });
    Sentry.captureException(err);
  });
  await Sentry.flush(2000);
}
