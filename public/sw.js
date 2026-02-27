// 通知を受け取った時の処理
self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : { title: 'RE-EYE-HUB', body: '新着情報があります', url: '/' };
    
    const options = {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      tag: 're-eye-hub-notification', // 同じ通知が重ならないように設定
      data: {
        url: data.url // クリック時に開くURLを保持
      }
    };
  
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  });
  
  // 通知をクリックした時の処理（楽天やYahooへの橋渡し）
  self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    
    // 保持していたURL（決済ページなど）を開く
    event.waitUntil(
      clients.openWindow(event.notification.data.url)
    );
  });