self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : { titulo: 'Moun Moun', corpo: '' };
  e.waitUntil(self.registration.showNotification(d.titulo, { body: d.corpo, icon: '/icon-192.png', badge: '/icon-192.png' }));
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(clients.openWindow('/')); });
