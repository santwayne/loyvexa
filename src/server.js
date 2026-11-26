import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';

await migrate();
if (config.whatsapp.sendMode !== 'live') console.warn('⚠️  WHATSAPP_SEND_MODE is not "live": WhatsApp replies are only saved in the message log, NOT sent to phones.');
if (config.calls.provider !== 'waynering') console.warn('⚠️  CALL_PROVIDER is not "waynering": AI calls are simulated and never reach WayneRing.');
createApp().listen(config.port, () => console.log(`${config.productName} API on :${config.port}`));
