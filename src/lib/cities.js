/**
 * Testing report 2 #10: "Ludihiana" on Participants vs "Ludhiana" on Calls. A city is now picked
 * from one list (registration dropdown, console forms, CSV import) and anything typed by hand is
 * snapped to the closest known spelling, so the same city is never stored two ways.
 *
 * Known cities = this starter list + every city the brand already has + settings.cities.
 */
export const COMMON_CITIES = [
  'Agra', 'Ahmedabad', 'Ajmer', 'Akola', 'Aligarh', 'Allahabad', 'Ambala', 'Amravati', 'Amritsar', 'Aurangabad',
  'Bareilly', 'Barnala', 'Bathinda', 'Bengaluru', 'Bhilai', 'Bhopal', 'Bhubaneswar', 'Bikaner', 'Chandigarh', 'Chennai',
  'Coimbatore', 'Dehradun', 'Delhi', 'Dhanbad', 'Faridabad', 'Faridkot', 'Fatehgarh Sahib', 'Firozpur', 'Ghaziabad', 'Gorakhpur',
  'Gurdaspur', 'Gurugram', 'Guwahati', 'Gwalior', 'Hisar', 'Hoshiarpur', 'Hubli', 'Hyderabad', 'Indore', 'Jabalpur',
  'Jaipur', 'Jalandhar', 'Jammu', 'Jamshedpur', 'Jodhpur', 'Kanpur', 'Kapurthala', 'Karnal', 'Khanna', 'Kochi',
  'Kolkata', 'Kota', 'Kozhikode', 'Kurukshetra', 'Lucknow', 'Ludhiana', 'Madurai', 'Mandi Gobindgarh', 'Mangaluru', 'Meerut',
  'Moga', 'Mohali', 'Moradabad', 'Mumbai', 'Muktsar', 'Mysuru', 'Nagpur', 'Nashik', 'Nawanshahr', 'Noida',
  'Panchkula', 'Panipat', 'Pathankot', 'Patiala', 'Patna', 'Phagwara', 'Pune', 'Raipur', 'Rajkot', 'Rajpura',
  'Ranchi', 'Rohtak', 'Rupnagar', 'Sangrur', 'Shimla', 'Sirsa', 'Solan', 'Sonipat', 'Srinagar', 'Surat',
  'Tarn Taran', 'Thane', 'Thiruvananthapuram', 'Udaipur', 'Vadodara', 'Varanasi', 'Vijayawada', 'Visakhapatnam', 'Yamunanagar', 'Zirakpur',
];

/** Same tidy rule as the DB trigger: trim, single spaces, Title Case. */
export const tidyCity = (c) => {
  const t = String(c || '').trim().replace(/\s+/g, ' ');
  return t ? t.toLowerCase().replace(/(^|[\s-])\S/g, (m) => m.toUpperCase()) : null;
};

function distance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Snap a typed city to a known spelling: exact (case-insensitive) match, else the closest
 * known city within 1 edit (short names) or 2 edits (8+ letters). Unknown cities are kept, tidied.
 */
export function canonicalCity(input, known = []) {
  const t = tidyCity(input);
  if (!t) return null;
  const list = [...new Set([...known.map(tidyCity).filter(Boolean), ...COMMON_CITIES])];
  const key = t.toLowerCase().replace(/[^a-z]/g, '');
  const exact = list.find((c) => c.toLowerCase().replace(/[^a-z]/g, '') === key);
  if (exact) return exact;
  const max = key.length >= 8 ? 2 : 1;
  let best = null, bestD = 99;
  for (const c of list) {
    const d = distance(key, c.toLowerCase().replace(/[^a-z]/g, ''));
    if (d < bestD) { best = c; bestD = d; }
  }
  return bestD <= max && key.length >= 4 ? best : t;
}
