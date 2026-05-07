/**
 * CTR 集計: Redis `ctr:sent:*` / `ctr:click:*`（INCR）
 */

import { withRedisRetry } from './redis.js';
import { opsJsonLog } from './notify-ops-log.js';

function normalizedTemplateSlug(templateId) {
  const t = typeof templateId === 'string' ? templateId.trim().slice(0, 64) : '';
  return (t || 'unknown').replace(/[^\w_-]/gu, '_') || 'unknown';
}

function ctrSentRedisKey(templateId) {
  return `ctr:sent:${normalizedTemplateSlug(templateId)}`;
}

function ctrClickRedisKey(templateId) {
  return `ctr:click:${normalizedTemplateSlug(templateId)}`;
}

function minWinnerSent() {
  const n = Number(process.env.RE_EYE_CTR_WINNER_MIN_SENT ?? 12);
  return Number.isFinite(n) && n > 3 ? Math.min(Math.floor(n), 100000) : 12;
}

export async function recordCtrTemplateSent(r, templateId) {
  const tk = ctrSentRedisKey(templateId || 'unknown');
  try {
    const n = await withRedisRetry(() => r.incr(tk), { label: 'ctr-sent-incr' });
    if (n === 1) {
      await withRedisRetry(() => r.expire(tk, 86400 * 120), {
        label: 'ctr-sent-exp',
      });
    }
  } catch {
    /* ignore */
  }
}

export async function recordCtrTemplateClick(r, templateId, userIdTrunc) {
  const tkClick = ctrClickRedisKey(templateId || 'unknown');
  try {
    const c = await withRedisRetry(() => r.incr(tkClick), { label: 'ctr-click-incr' });
    if (c === 1) {
      await withRedisRetry(() => r.expire(tkClick, 86400 * 120), {
        label: 'ctr-click-exp',
      });
    }
    const tkSent = ctrSentRedisKey(templateId || 'unknown');
    let sentRaw = '0';
    try {
      sentRaw = await withRedisRetry(() => r.get(tkSent), { label: 'ctr-sent-get' });
    } catch {
      sentRaw = '0';
    }
    const sentNum = Number(sentRaw || 0) || 0;
    const clickNum = c;
    const ratio = sentNum > 0 ? clickNum / sentNum : null;

    opsJsonLog('ctr_dashboard', {
      template: String(templateId || 'unknown').slice(0, 64),
      sent: sentNum,
      clicks: clickNum,
      ratio: ratio != null ? Math.round(ratio * 1000) / 1000 : null,
      userHint: userIdTrunc,
    });

    if (ratio != null && sentNum >= minWinnerSent() && ratio > 0.15) {
      try {
        await withRedisRetry(
          () =>
            r.set('ctr:winner:template:v2', String(templateId).slice(0, 64), {
              ex: 86400 * 60,
            }),
          { label: 'ctr-winner-set' },
        );
        opsJsonLog('ctr_mark_winner', {
          template: String(templateId).slice(0, 64),
          ratio:
            ratio != null ? Math.round(ratio * 1000) / 1000 : null,
          sent: sentNum,
        });
      } catch {
        /* */
      }
    }
  } catch {
    /* ignore */
  }
}
