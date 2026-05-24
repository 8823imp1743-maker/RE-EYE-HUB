/**
 * /api/health.js — 軽量生存確認
 * 外部依存なし。Vercel の Function カウント：2個目（index.js が1個目）
 */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, ts: Date.now() });
}
