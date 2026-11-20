import { config } from '../config.js';

/**
 * Bundle rules (Loopdesk, Nov 2026 — "06 Loyvexa Easy Guide, corrected").
 *
 * Every tool does only its own job:
 *   - Calls only through WayneRing, and only when WayneRing is in the client's package.
 *   - WhatsApp / SMS to customers goes out through Regulars (one client = one
 *     WhatsApp number, set up in Regulars Settings). Loyvexa only picks who
 *     gets what (segments, schemes, bot replies).
 *   - Overdue payments / reorders are Korvo's call: Loyvexa only shows them,
 *     and only when Korvo is linked.
 *
 * A brand made by the hub (hub_business_id set) follows these rules. The hub
 * sends the package's tools in the provision call (`tools`), kept in
 * settings.hub.tools. A brand made by hand (demo, old clients) keeps working
 * as before; a super admin can still set settings.packageTools on it.
 */
export const isHubBrand = (tenant) => !!tenant?.hub_business_id;

/** Tools in the client's package (upper-case, e.g. WAYNERING), or null when unknown. */
export function packageTools(tenant) {
  const s = tenant?.settings || {};
  const list = Array.isArray(s.packageTools) ? s.packageTools : Array.isArray(s.hub?.tools) ? s.hub.tools : null;
  return list ? list.map((t) => String(t).toUpperCase()) : null;
}

/** AI calls (console page, AI Manager win-back) only with WayneRing in the package. */
export function hasWayneRing(tenant) {
  const tools = packageTools(tenant);
  if (tools) return tools.includes('WAYNERING');
  return !isHubBrand(tenant); // hub brand without a tool list: no calls
}

/** Korvo tiles (orders, overdue, recovered) only when the brand is linked to Korvo. */
export const korvoLinked = (tenant) => !!tenant?.korvo?.companyCode;

/** Hub brands send WhatsApp through Regulars' number once REGULARS_API_URL + HUB_SECRET are set. */
export function waViaRegulars(tenant) {
  return isHubBrand(tenant) && !!config.regulars.apiUrl && config.hub.secret.length >= 32;
}

/** What the console needs to show or hide pages. */
export function bundleInfo(tenant) {
  return {
    hubBrand: isHubBrand(tenant),
    tools: packageTools(tenant),
    calls: hasWayneRing(tenant),
    korvo: korvoLinked(tenant),
    whatsappViaRegulars: waViaRegulars(tenant),
    // Bundle client: the number is set up in Regulars, not on Loyvexa's WhatsApp page.
    whatsappSetupHere: !isHubBrand(tenant),
  };
}
