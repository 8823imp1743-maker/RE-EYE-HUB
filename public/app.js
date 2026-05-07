import { monitor } from './simple-monitor.js';
import { notify, setupPush } from './notify.js';

const items = [
  { url: 'https://example.com/item1', size: '26.5', type: 'shoe' },
  { url: 'https://example.com/item2', size: 'S', type: 'clothing' },
];

void (async () => {
  try {
    await setupPush();
  } catch {
    /* ignore */
  }

  setInterval(() => {
    void monitor(items, (item) => {
      notify('在庫復活', item.url);
    });
  }, 60000);
})();
