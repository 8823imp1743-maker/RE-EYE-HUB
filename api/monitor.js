export default async function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  return res.end(JSON.stringify({
    ok: true,
    status: 'monitor route alive',
    timestamp: new Date().toISOString(),
    items: []
  }));
}