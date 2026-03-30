/**
 * GET /api/categories
 * Yahoo!ショッピング風 カテゴリツリー取得（UI用）
 * マルチソース: 各カテゴリに EC/公式サイト/X/ファンクラブ 等のソースが紐づく
 */

import { getCategoryTree, SOURCE_TYPES } from '../../lib/categories.js';
import { sendJson } from '../../lib/response.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    const tree = await getCategoryTree();
    const withSourceTypes = {
      sourceTypes: SOURCE_TYPES,
      categories: buildTree(tree)
    };
    sendJson(res, 200, withSourceTypes);
  } catch (err) {
    console.error('Categories error:', err);
    sendJson(res, 500, { error: 'Failed to load categories' });
  }
}

/** 親子関係でツリー構造に変換 */
function buildTree(flat) {
  const byId = {};
  flat.forEach(c => { byId[c.id] = { ...c, children: [] }; });
  const roots = [];
  flat.forEach(c => {
    const node = byId[c.id];
    if (!c.parentId) {
      roots.push(node);
    } else if (byId[c.parentId]) {
      byId[c.parentId].children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots.sort((a, b) => (a.order || 0) - (b.order || 0));
}
