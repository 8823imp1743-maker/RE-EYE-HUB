/**
 * 通知フィルタ・カテゴリ判定
 * 行動喚起（CTA）フィルタ: 「今すぐ動くべき理由」がある情報に [重要] タグを付与
 */

// コンサート系：除外ワード（含む場合は通知しない）
const EXCLUDE_WORDS = [
  'LIVE', 'live',
  'TOUR', 'tour', 'ツアー',
  '公演', 'チケット', '会場', '開演', '物販',
  'ライブ', 'コンサート', 'フェス', 'イベント会場'
];

// 重要ワード：カテゴリ判定用
const CATEGORY_PATTERNS = {
  '予約/受付開始': ['予約開始', '受付開始', '予約受付'],
  '締切・終了間近': ['締切', '締め切り', '終了間近', '締め切り間近', '募集締切', '本日締切'],
  '再販/在庫復活': ['再販', '在庫復活', '再入荷', '入荷'],
  '新商品/お知らせ': ['数量限定', '先着', '抽選', '新商品', 'お知らせ', '発売']
};

/** CTA（行動喚起）ワード： [重要] タグ + 優先通知の対象 */
const CTA_PRIORITY_WORDS = [
  '予約開始', '受付開始', '抽選受付', '本日締切', '締切間近',
  '予約受付', '申込開始', '販売開始', '再販', '在庫復活',
  '数量限定', '先着', '今すぐ', 'ただ今'
];

/**
 * 除外対象かどうか（コンサート系など）
 */
export function shouldExclude(title = '', body = '') {
  const text = `${title} ${body}`.toLowerCase();
  const excludeLower = EXCLUDE_WORDS.map(w => w.toLowerCase());
  return excludeLower.some(word => text.includes(word));
}

/**
 * CTA（行動喚起）かどうか → [重要] タグ付与・優先通知の判定
 */
export function isCtaPriority(title = '', body = '') {
  const text = `${title} ${body}`;
  return CTA_PRIORITY_WORDS.some(w => text.includes(w));
}

/**
 * 通知カテゴリを決定
 * 戻り値: { category, isImportant } — isImportant なら [重要] タグを付与
 */
export function getNotificationCategory(title = '', body = '') {
  const text = `${title} ${body}`;
  for (const [category, words] of Object.entries(CATEGORY_PATTERNS)) {
    if (words.some(w => text.includes(w))) {
      const isImportant = isCtaPriority(title, body);
      return { category, isImportant };
    }
  }
  const isImportant = isCtaPriority(title, body);
  return { category: '新商品/お知らせ', isImportant };
}
