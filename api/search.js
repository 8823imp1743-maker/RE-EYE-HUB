export default async function handler(req, res) {
  const keyword =
    req.query?.keyword ||
    req.query?.q ||
    '';

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  return res.end(JSON.stringify({
    found: false,
    items: [],
    normalizedKeyword: keyword,
    errors: [],
    sourceNote: 'temporary_recovery_stub',
    debug: { stub: true }
  }));
}