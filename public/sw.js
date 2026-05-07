// Push: JSON（既存／OneSignal 等）を優先し、text のみならフォールバック表示
self.addEventListener('push', function (event) {
    let data = { title: 'RE-EYE-HUB', body: '新着情報があります', url: '/' };

    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            const txt = event.data.text();
            data = { title: '在庫通知', body: txt || '在庫復活', url: '/' };
        }
    }

    const title = typeof data.title === 'string' && data.title ? data.title : 'RE-EYE-HUB';
    const body = typeof data.body === 'string' && data.body ? data.body : data.body || '';
    const openUrl =
        typeof data.url === 'string' && data.url ? data.url : '/';

    const options = {
        body,
        icon: '/icon.png',
        badge: '/icon.png',
        tag: 're-eye-hub-notification',
        data: { url: openUrl },
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// 通知クリック（楽天／Yahoo 等へ橋渡し）
self.addEventListener('notificationclick', function (event) {
    event.notification.close();

    const url =
        event.notification.data && typeof event.notification.data.url === 'string'
            ? event.notification.data.url
            : '/';

    event.waitUntil(clients.openWindow(url));
});
