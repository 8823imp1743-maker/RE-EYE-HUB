/**
 * POST /api/poll
 * ショップ横断リアルタイムポーリングエンドポイント
 *
 * リクエスト Body:
 *   { keyword: string, userId: string, plan?: 'FREE'|'STANDARD'|'PRO'|'VIP' }
 *
 * 認証:
 *   Authorization: Bearer <WEBHOOK_SECRET>
 *
 * レスポンス:
 *   { newItems, allItems, errors, checkedAt }
 *   各 item にはマイサイズ設定がある場合のみ sizeRank: 'A'|'B'|'C' が付く（厳格ルール）
 *
 * データフロー:
 *   searchAllCached()（楽天・Yahoo） → seenチェック(Redis) → …
 */

import { createHash } from 'crypto';
import { searchAllCached } from '../lib/shop-search-cache.js';
import { getRedis, markSeen, isSeen, withRedisRetry } from '../lib/redis.js';
import { shouldExclude, getNotificationCategory } from '../lib/filters.js';
import { extractSizeFromKeyword } from '../lib/cross-validator.js';
import { sendOneSignalNotification } from '../lib/notification.js';
import {
  sanitizeUserId,
  sanitizeStoredUserSettings,
  userSettingsKey,
} from '../lib/user-settings.js';
import { stampPollSizeRankAndSort, buildSerpRuleEntryForKeyword } from '../lib/serp-item-rule.js';
import { evaluateAttributeGate, attributeGateSkipLogPayload } from '../lib/attribute-gate.js';
import { buildFunnelPayloadFromKeyword } from '../lib/purchase-funnel.js';
import {
  applyUserSizesToKeywordFromSettings,
  getUserMallPreserveTokens,
} from '../lib/user-size.js';
import { shoeProfileAllowsListing } from '../lib/shoe-size-gate.js';
import { listingCmFromSizeInfo, sizeTagKeysForListingTolerance } from '../lib/size-bucket-tags.js';
import {
  allowUserPushPerMinute,
  allowUserPushPer5Min,
  allowUserPushPerDay,
} from '../lib/push-rate-limit.js';
import { enqueueDigestItem } from '../lib/digest.js';
import { userPlanKey } from '../lib/monitor-constants.js';
import {
  digestPathForPlan,
  coercePlanTier,
  isPaidPlan,
} from '../lib/notify-plan-policy.js';
import { getTimeScoreJst, getJstHour } from '../lib/notify-time-jst.js';
import { computeCtrBoostScore } from '../lib/notify-ctr-boost.js';
import { allowFreePushMinGap } from '../lib/notify-min-gap.js';
import { opsJsonLog } from '../lib/notify-ops-log.js';
import { ctrVariant, buildStockMonitorCtr } from '../lib/notify-ctr.js';
import { computeLtqScore, shouldSkipLtqFree } from '../lib/notify-ltv.js';
import { freeDailyCapPreSend } from '../lib/free-user-daily-cap.js';

// プラン別の検索件数上限
const PLAN_MAX_RESULTS = {
  FREE:     5,
  STANDARD: 15,
  PRO:      30,
  VIP:      30,
};

// Redis キャッシュ TTL（秒）
const CACHE_TTL = {
  FREE:     3600,  // 1時間
  STANDARD: 600,   // 10分
  PRO:      60,    // 1分
  VIP:      60,
};

async function resolvePollNotifyPlan(r, bodyPlan, uid) {
  try {
    const raw = await withRedisRetry(() => r.get(userPlanKey(uid)), {
      label: 'poll:user-plan',
    });
    if (raw) return coercePlanTier(raw);
  } catch {
    /* ignore */
  }
  return coercePlanTier(bodyPlan);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 認証チェック
  const secret = process.env.WEBHOOK_SECRET;
  const authHeader = req.headers.authorization || '';
  if (secret && authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { keyword, userId, plan = 'FREE' } = req.body || {};
  if (!keyword || !userId) {
    return res.status(400).json({ error: 'keyword and userId are required' });
  }

  const maxResults = PLAN_MAX_RESULTS[plan] || 5;

  let storedUserSettings = null;
  const safeUserId = sanitizeUserId(userId);
  if (safeUserId) {
    try {
      const r = getRedis();
      const raw = await withRedisRetry(() => r.get(userSettingsKey(safeUserId)), {
        label: 'poll:user-settings',
      });
      storedUserSettings = sanitizeStoredUserSettings(raw);
    } catch (e) {
      console.warn('[poll] user-settings:', e.message);
    }
  }

  const baseKw = String(keyword || '').trim();
  let searchKeyword = baseKw;
  let mallPreserveTokens = [];
  if (storedUserSettings && typeof storedUserSettings === 'object') {
    searchKeyword = applyUserSizesToKeywordFromSettings(storedUserSettings, baseKw, false);
    mallPreserveTokens = getUserMallPreserveTokens(storedUserSettings, baseKw, false);
  }

  // 1. 全アクティブショップで並列検索
  const { items: rawItems, errors } = await searchAllCached(searchKeyword, {
    maxResults,
    inStockOnly: false,
    cacheTtlSec: CACHE_TTL[plan] || 60,
    ...(mallPreserveTokens.length ? { mallPreserveTokens } : {}),
  });

  const safeRawItems = Array.isArray(rawItems)
    ? rawItems.filter(it => it != null && typeof it === 'object')
    : [];
  let allItems;
  try {
    allItems = stampPollSizeRankAndSort(safeRawItems, storedUserSettings);
  } catch (e) {
    console.error('[poll] stampPollSizeRankAndSort(allItems):', e.message);
    allItems = safeRawItems;
  }

  // 2. 各アイテムの seenチェック → 未見のみ抽出
  const newItems = [];
  await Promise.all(
    allItems.map(async item => {
      try {
        const hash = createHash('sha256').update(item.itemId).digest('hex');
        const key  = `seen:${userId}:${item.sourceId}:${hash}`;
        const seen = await isSeen(key);
        if (!seen) {
          newItems.push(item);
          await markSeen(key);
        }
      } catch (e) {
        console.warn('[poll] seen/redis:', e.message);
      }
    })
  );

  let sortedNewItems;
  try {
    sortedNewItems = stampPollSizeRankAndSort(newItems, storedUserSettings);
  } catch (e) {
    console.error('[poll] stampPollSizeRankAndSort(newItems):', e.message);
    sortedNewItems = newItems;
  }

  // 3. フィルタリング（除外ワード除去・カテゴリ分類）
  const filteredNew = sortedNewItems.filter(item =>
    !shouldExclude(item.title, item.title) // LIVE/チケット等は除外
  );

  let sortedFilteredNew;
  try {
    sortedFilteredNew = stampPollSizeRankAndSort(filteredNew, storedUserSettings);
  } catch (e) {
    console.error('[poll] stampPollSizeRankAndSort(filteredNew):', e.message);
    sortedFilteredNew = filteredNew;
  }

  // 4. 在庫ありの新着アイテムがあれば OneSignal でプッシュ通知（ユーザー狙い撃ち）
  const inStockNew = sortedFilteredNew.filter(i => i.available);
  if (inStockNew.length > 0 && safeUserId) {
    try {
      const top = inStockNew[0];
      const topPrice = Number(top.price) || 0;
      const kwSz = extractSizeFromKeyword(baseKw);
      const prof =
        typeof storedUserSettings === 'object' && storedUserSettings
          ? storedUserSettings
          : null;

      const rBurst = getRedis();
      const notifyPlan = await resolvePollNotifyPlan(rBurst, plan, safeUserId);
      const useDigest = digestPathForPlan(notifyPlan) === 'digest';

      if (!shoeProfileAllowsListing(prof, kwSz)) {
        opsJsonLog('size_gate_skip', {
          source: 'poll',
          userId: String(safeUserId).slice(0, 10),
        });
      } else {
        const minLtqRaw = Number(process.env.RE_EYE_LTV_MIN_SCORE_FREE);
        const minLtq = Number.isFinite(minLtqRaw) ? minLtqRaw : 0;
        const ltqScore = computeLtqScore({
          available: top.available !== false,
          price: topPrice,
          listPrice: 0,
          title: top.title || '',
        });
        const skipLtq =
          shouldSkipLtqFree({
            plan: notifyPlan,
            score: ltqScore,
            minScore: minLtq,
            skipPaidLtq: true,
          });
        if (skipLtq) {
          opsJsonLog('notification_skip_ltq', { source: 'poll', score: ltqScore, min: minLtq });
        } else {
          const boostMinRaw = Number(process.env.RE_EYE_CTR_BOOST_MIN_SCORE_FREE ?? '0');
          const boostMin = Number.isFinite(boostMinRaw) ? boostMinRaw : 0;
          const boostScore = computeCtrBoostScore({
            shoeRaw: kwSz?.type === 'shoe' ? kwSz.raw : '',
            title: top.title || '',
            keyword: baseKw,
          });
          if (boostMin > 0 && !isPaidPlan(notifyPlan) && boostScore < boostMin) {
            opsJsonLog('ctr_boost_skip', {
              source: 'poll',
              score: boostScore,
              min: boostMin,
            });
          } else {
            const dc = await freeDailyCapPreSend(rBurst, safeUserId, notifyPlan);
            if (!dc.ok) {
              opsJsonLog('notification_skip_daily_cap_free', {
                cap: dc.cap,
                cur: dc.cur,
              });
            } else {
              const burstOk =
                (await allowUserPushPerMinute(rBurst, safeUserId, {
                  label: 'poll-push-u1m',
                })) &&
                (await allowUserPushPer5Min(rBurst, safeUserId, {
                  label: 'poll-push-u5m',
                })) &&
                (await allowUserPushPerDay(rBurst, safeUserId, {
                  label: 'poll-push-u1d',
                }));

              if (!burstOk) {
                opsJsonLog('rate_limit_skip', { source: 'poll' });
              } else {
                const freePeakDefer =
                  process.env.RE_EYE_FREE_PEAK_DEFER === '1' ||
                  process.env.RE_EYE_FREE_PEAK_DEFER === 'true';
                if (
                  freePeakDefer &&
                  notifyPlan === 'FREE' &&
                  !useDigest &&
                  getTimeScoreJst() < 1.0
                ) {
                  opsJsonLog('notify_defer_offpeak', {
                    source: 'poll',
                    userId: String(safeUserId).slice(0, 10),
                    jstHour: getJstHour(),
                  });
                } else if (!(await allowFreePushMinGap(rBurst, safeUserId, notifyPlan))) {
                  opsJsonLog('notify_skip_min_gap', { source: 'poll' });
                } else {
                  const pollEntry = { ...buildSerpRuleEntryForKeyword(baseKw), keyword: baseKw };
                  const pollAttrGate = evaluateAttributeGate(pollEntry, top);
                  if (!pollAttrGate.pass) {
                    opsJsonLog('attribute_gate_skip', {
                      ...attributeGateSkipLogPayload(pollAttrGate, top, 'poll'),
                      userId: String(safeUserId).slice(0, 10),
                    });
                  } else {
                  const { category, isImportant } = getNotificationCategory(top.title, top.title);
                  const prefix = isImportant ? '[重要] ' : '';

                  let sizeTagKeysPoll;
                  if (kwSz && kwSz.type === 'shoe') {
                    const lcm = listingCmFromSizeInfo(kwSz);
                    if (lcm != null) {
                      const ks = sizeTagKeysForListingTolerance(lcm);
                      if (ks.length) sizeTagKeysPoll = ks;
                    }
                  }

                  const variant = ctrVariant(safeUserId);
                  const ctrPack = buildStockMonitorCtr({
                    itemTitle: top.title,
                    keywordLabel: `${prefix}${top.shopName || 'ショップ'}在庫`,
                    shoeRaw: kwSz?.type === 'shoe' ? kwSz.raw : undefined,
                    price: topPrice,
                    listPrice: 0,
                    variant,
                    stockHint: 'ok',
                  });
                  let titleOut = ctrPack.title;
                  if (isImportant) titleOut = `[重要] ${titleOut}`.slice(0, 90);
                  const pollFunnel = buildFunnelPayloadFromKeyword(baseKw, safeUserId, 'poll_in_stock');

                  if (useDigest) {
                    await enqueueDigestItem(rBurst, {
                      target: safeUserId,
                      item: {
                        type: 'poll_in_stock',
                        displayTitle: titleOut,
                        displayMessage: ctrPack.message,
                        title: `${prefix}${top.shopName}で在庫あり`,
                        url: top.url,
                        itemUrl: top.url,
                        category,
                        userId: safeUserId,
                        itemId: top.itemId,
                        sourceId: top.sourceId,
                        keyword: baseKw,
                        ctrTemplate: ctrPack.templateId,
                        opsPlan: notifyPlan,
                        ...pollFunnel,
                        ...(sizeTagKeysPoll ? { sizeTagKeys: sizeTagKeysPoll } : {}),
                      },
                      onFlush: async ({ target, stamp, items }) => {
                        if (!items || items.length === 0) return;
                        const first = items[0] || {};
                        const count = items.length;
                        const ttl =
                          first.displayTitle || `[まとめ通知] 新着 ${count}件`;
                        const m =
                          first.displayMessage ||
                          `${(first.title || '新着').slice(0, 110)}${
                            count > 1 ? ` ほか${count - 1}件` : ''
                          }`;
                        const tmplDig =
                          typeof first.ctrTemplate === 'string'
                            ? first.ctrTemplate
                            : count > 1
                              ? 'digest_multi'
                              : 'digest_single';
                        const digFunnel = buildFunnelPayloadFromKeyword(
                          first.keyword || baseKw,
                          target,
                          'poll_digest',
                        );
                        await sendOneSignalNotification({
                          title: ttl,
                          message: m,
                          url: first.url || '',
                          category: first.category || undefined,
                          data: {
                            type: 'digest',
                            userId: target,
                            digestStamp: stamp,
                            digestCount: count,
                            ctrTemplate: tmplDig,
                            opsPlan: first.opsPlan || 'FREE',
                            opsSource: 'poll_digest',
                            itemUrl: first.url || '',
                            ...digFunnel,
                            ...(Array.isArray(first.sizeTagKeys)
                              ? { sizeTagKeys: first.sizeTagKeys }
                              : {}),
                          },
                        });
                      },
                    });
                  } else {
                    await sendOneSignalNotification({
                      title: titleOut,
                      message: ctrPack.message,
                      url: top.url,
                      category,
                      data: {
                        type: 'poll_in_stock',
                        userId: safeUserId,
                        opsPlan: notifyPlan,
                        opsSource: 'poll_in_stock',
                        ctrVariant: variant,
                        ctrTemplate: ctrPack.templateId,
                        itemId: top.itemId,
                        sourceId: top.sourceId,
                        keyword: baseKw,
                        itemUrl: top.url,
                        ...pollFunnel,
                        ...(sizeTagKeysPoll ? { sizeTagKeys: sizeTagKeysPoll } : {}),
                      },
                    });
                  }
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      opsJsonLog('notification_send_fail', {
        source: 'poll',
        message: e instanceof Error ? e.message : String(e),
      });
      console.error('OneSignal push failed:', e.message);
    }
  }

  // 5. 結果を Redis にキャッシュ（フロントのステータス取得用）
  const cacheKey = buildCacheKey(userId, searchKeyword);
  const ttl = CACHE_TTL[plan] || 3600;
  try {
    const r = getRedis();
    await r.set(cacheKey, JSON.stringify({
      allItems,
      newItems: sortedFilteredNew,
      checkedAt: Date.now(),
    }), { ex: ttl });
  } catch (e) {
    console.error('Redis cache write failed:', e.message);
  }

  return res.status(200).json({
    newItems:  sortedFilteredNew,
    allItems,
    errors,
    checkedAt: Date.now(),
  });
}

/** Redis キャッシュキー生成 */
function buildCacheKey(userId, keyword) {
  const hash = createHash('sha256').update(keyword.toLowerCase().trim()).digest('hex').slice(0, 16);
  return `poll:results:${userId}:${hash}`;
}
