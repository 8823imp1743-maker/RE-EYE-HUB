/**
 * POST /api/chat
 * AI 対話は停止（Gemini 非使用・コストゼロ運用）
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  return res.status(503).json({
    maintenance: true,
    message: 'ユーザー交流チャットは現在メンテナンス中です。AI を利用しません。',
  });
}
