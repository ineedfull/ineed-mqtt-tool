'use strict';
const { randomUUID } = require('node:crypto');

function requestUpdatePreparation({ window, ipcMain, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    if (!window || window.isDestroyed()) return reject(new Error('主窗口不可用'));
    const requestId = randomUUID();
    function finish(error) {
      clearTimeout(timer);
      ipcMain.removeListener('lifecycle:before-close-ack', acknowledge);
      window.removeListener?.('closed', destroyed);
      if (error) reject(error); else resolve();
    }
    function acknowledge(event, payload) {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || payload?.requestId !== requestId || typeof payload.ok !== 'boolean') return;
      finish(payload.ok ? null : new Error(payload.error?.message || '更新前保存失败'));
    }
    function destroyed() { finish(new Error('更新保存期间窗口已关闭')); }
    const timer = setTimeout(() => finish(new Error('更新前保存确认超时')), timeoutMs);
    ipcMain.on('lifecycle:before-close-ack', acknowledge);
    window.on?.('closed', destroyed);
    try { window.webContents.send('lifecycle:before-close', { requestId, purpose: 'update' }); }
    catch (error) { finish(error); }
  });
}

module.exports = { requestUpdatePreparation };
