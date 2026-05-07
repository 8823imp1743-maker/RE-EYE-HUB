export async function setupPush() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await Notification.requestPermission();

  return reg;
}

export function notify(title, body) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}
