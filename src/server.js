import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { fixCities } from './services/segments.js';

await migrate();
// Testing report 2 #10: one spelling per city ("Ludihiana" → "Ludhiana") for rows saved before the fix.
await fixCities().then((n) => n && console.log(`fixed ${n} city spellings`)).catch((e) => console.warn('city fix skipped:', e.message));
if (config.whatsapp.sendMode !== 'live') console.warn('⚠️  WHATSAPP_SEND_MODE is not "live": WhatsApp replies are only saved in the message log, NOT sent to phones.');
if (config.calls.provider !== 'waynering') console.warn('⚠️  CALL_PROVIDER is not "waynering": AI calls are simulated and never reach WayneRing.');
createApp().listen(config.port, () => console.log(`${config.productName} API on :${config.port}`));
