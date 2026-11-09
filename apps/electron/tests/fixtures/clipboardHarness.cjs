const { app } = require('electron');

// Keep this native test isolated from the user's running app and database.
app.setPath('userData', process.env.INEED_CLIPBOARD_TEST_USER_DATA);
// The development Electron entry starts itself when process.defaultApp is true.
require('../../electron/main.cjs');
