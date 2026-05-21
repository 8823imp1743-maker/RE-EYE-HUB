/**
 * SNS情報の正規化
 * X / Instagram の生データを Webニュースと同じフォーマット { title, body, url } に変換
 * （将来的にAIで要約・変換する拡張ポイントを設ける）
 */

/**
 * 生のSNSアイテムを正規化
 * @param {object} raw - X/Instagram の生投稿
 * @param {'x'|'instagram'} sourceType
 * @returns {{ id, title, body, url, publishedAt? }}
 */
export function normalizeSnsItem(raw, sourceType) {
  if (!raw || typeof raw !== 'object') return null;

  switch (sourceType) {
    case 'x':
      return normalizeX(raw);
    case 'instagram':
      return normalizeInstagram(raw);
    default:
      return normalizeGeneric(raw);
  }
}

function normalizeX(raw) {
  const id = raw.id || raw.id_str || raw.post_id || '';
  const text = raw.text || raw.full_text || raw.content || '';
  const author = raw.author?.username || raw.user?.screen_name || raw.screen_name || 'X';
  const url = raw.url || raw.permalink || (id ? `https://x.com/i/status/${id}` : '');

  return {
    id: String(id),
    title: `${author} からの投稿`,
    body: text.slice(0, 500),
    url: url || '',
    publishedAt: raw.created_at || raw.published_at || null
  };
}

function normalizeInstagram(raw) {
  const id = raw.id || raw.pk || '';
  const caption = raw.caption || raw.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  const shortcode = raw.shortcode || '';
  const url = raw.url || raw.permalink || (shortcode ? `https://www.instagram.com/p/${shortcode}/` : '');

  return {
    id: String(id || shortcode || Date.now()),
    title: 'Instagram 投稿',
    body: (caption || '（画像投稿）').slice(0, 500),
    url: url || '',
    publishedAt: raw.taken_at_timestamp ? new Date(raw.taken_at_timestamp * 1000).toISOString() : null
  };
}

function normalizeGeneric(raw) {
  return {
    id: raw.id || raw.url || String(Date.now()),
    title: raw.title || 'お知らせ',
    body: (raw.body || raw.text || raw.content || '').slice(0, 500),
    url: raw.url || raw.link || '',
    publishedAt: raw.publishedAt || raw.published_at || raw.created_at || null
  };
}

/**
 * items 配列を一括正規化（sourceType に応じて）
 */
export function normalizeItems(items, sourceType) {
  if (!Array.isArray(items)) return [];
  const st = String(sourceType).toLowerCase();
  const needsNormalize = ['x', 'instagram'].includes(st);

  return items
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      if (needsNormalize) {
        return normalizeSnsItem(item, st);
      }
      return normalizeGeneric(item);
    })
    .filter(Boolean);
}
