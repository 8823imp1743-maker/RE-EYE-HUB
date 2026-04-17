/**
 * OneSignal REST API によるプッシュ通知
 * MVP: 全購読者に送信
 */

export async function sendOneSignalNotification({
  title,
  message,
  url,
  category,
  data = {}
}) {
  // ONESIGNAL_KEY を App ID として使用（UUID 形式）
  // REST API Key は ONESIGNAL_REST_KEY → ONESIGNAL_API_KEY の順にフォールバック
  const appId  = process.env.ONESIGNAL_KEY || process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_KEY || process.env.ONESIGNAL_API_KEY || '';

  if (!appId) {
    throw new Error('ONESIGNAL_KEY (App ID) must be set');
  }

  // userId タグが設定されたデバイスだけに狙い撃ち。
  // フロントで OneSignal.sendTag('userId', userId) を呼んでいる場合に有効。
  // userId がない場合（Webhook 一斉通知等）は全購読者にフォールバック。
  const targeting = data.userId
    ? { filters: [{ field: 'tag', key: 'userId', relation: '=', value: String(data.userId) }] }
    : { included_segments: ['All'] };

  const body = {
    app_id: appId,
    ...targeting,
    headings: { en: title, ja: title },
    contents: { en: message, ja: message },
    url: url || undefined,
    data: {
      ...data,
      category: category || '新商品/お知らせ'
    }
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Key ${apiKey}`;

  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OneSignal API error: ${res.status} ${text}`);
  }

  return res.json();
}
