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
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_API_KEY;

  if (!appId || !apiKey) {
    throw new Error('ONESIGNAL_APP_ID and ONESIGNAL_API_KEY must be set');
  }

  const body = {
    app_id: appId,
    included_segments: ['All'], // 全購読者（MVP）
    headings: { en: title },
    contents: { en: message },
    url: url || undefined,
    data: {
      ...data,
      category: category || '新商品/お知らせ'
    }
  };

  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OneSignal API error: ${res.status} ${text}`);
  }

  return res.json();
}
