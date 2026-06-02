// MarketScan Service Worker — gerencia notificações push em background

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Recebe notificação push do servidor
self.addEventListener('push', e => {
  if (!e.data) return;

  let data;
  try { data = e.data.json(); } catch { data = { title: 'MarketScan', body: e.data.text() }; }

  const options = {
    body: data.body || 'Nova oportunidade encontrada!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'marketscan-alert',
    renotify: true,
    requireInteraction: true, // mantém notificação na tela até o usuário interagir
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'Ver anúncio' },
      { action: 'dismiss', title: 'Fechar' },
    ],
  };

  e.waitUntil(self.registration.showNotification(data.title || '🔥 MarketScan', options));
});

// Clique na notificação — abre o anúncio
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Se já tem uma janela aberta, foca nela
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (url.startsWith('http')) client.navigate(url);
          return;
        }
      }
      // Senão abre uma nova
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
