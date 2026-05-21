export default async function handler(req, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify({
    ok: true,
    stub: true,
    items: [],
    message: "temporary_recovery_stub"
  }));
}
