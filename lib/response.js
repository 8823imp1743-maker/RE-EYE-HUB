/**
 * JSON レスポンス送信（Node.js ServerResponse 用）
 */

export function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
