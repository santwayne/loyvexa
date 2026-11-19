/**
 * Call scripts handed to the voice agent (WayneRing). Variables are filled per participant.
 * The agent gets a first line to say and short instructions; it must report one outcome:
 * INTERESTED | NOT_INTERESTED | NO_ANSWER | WRONG_NUMBER | CALL_LATER | DO_NOT_CALL
 */
const T = {
  WINBACK: {
    hi: { first: 'Namaste {name} ji, main {brand} ki taraf se bol rahi hoon. Kaafi din se aapne {brand} ka koi scan nahi kiya — sab theek hai?', goal: 'Poocho ki scan kyun band hua (stock nahi mila, app issue, competitor offer). Batao ki unke paas {balance} points hain. Live scheme: {scheme}. Unhe WhatsApp pe app link bhejne ki permission lo.' },
    pa: { first: 'Sat Sri Akal {name} ji, main {brand} vallon gall kar rahi haan. Kaafi dinaan ton tusi koi scan nahi kita — sab theek hai?', goal: 'Puchho scan kyon band hoya. Dasso ki unhaan kol {balance} points ne. Scheme: {scheme}.' },
    en: { first: 'Hello {name}, this is {brand} calling. We noticed you have not scanned for a while — is everything okay?', goal: 'Ask why scanning stopped. Mention their {balance} points balance and the live scheme: {scheme}.' },
  },
  SCHEME_REMINDER: {
    hi: { first: 'Namaste {name} ji, {brand} se call hai. Aapke liye ek scheme chal rahi hai: {scheme}.', goal: 'Scheme ki last date aur agla slab clearly batao. Koi sawaal ho toh jawab do. Pressure mat dalo.' },
    pa: { first: 'Sat Sri Akal {name} ji, {brand} ton call hai. Tuhade layi scheme chal rahi hai: {scheme}.', goal: 'Scheme di last date te agla slab dasso.' },
    en: { first: 'Hello {name}, this is {brand}. There is a scheme running for you: {scheme}.', goal: 'Explain the end date and the next slab. Answer questions; no pressure.' },
  },
  // Used by the AI Channel Manager for dealers who stopped ordering.
  DEALER_WINBACK: {
    hi: { first: 'Namaste {name} ji, main {brand} ki taraf se bol rahi hoon. Kaafi dinon se aapka order nahi aaya — sab theek hai?', goal: 'Pyaar se poocho order kyun ruka: stock abhi bhi hai, rate ka issue, delivery late, payment, ya competitor. Unki baat dhyan se suno aur summary mein likho. Agar order dena chahte hain toh batao ki WhatsApp pe "order" likh kar seedha order de sakte hain. Pressure mat dalo, discount promise mat karo.' },
    pa: { first: 'Sat Sri Akal {name} ji, main {brand} vallon gall kar rahi haan. Kaafi dinaan ton tuhada order nahi aaya — sab theek hai?', goal: 'Puchho order kyon rukeya: stock, rate, delivery, payment ja koi hor company. Summary vich likho. Order dena hove taan WhatsApp te "order" likh ke de sakde ne. Discount da vaada na karo.' },
    en: { first: 'Hello {name}, this is {brand} calling. We haven\'t had an order from you in a while — is everything okay?', goal: 'Ask kindly why ordering stopped: stock still on hand, price, late delivery, payment, or a competitor. Listen and summarise. If they want to order, tell them they can send "order" on WhatsApp. No pressure and no discount promises.' },
  },
  FEEDBACK: {
    hi: { first: 'Namaste {name} ji, {brand} se bol rahi hoon. Do minute mein aapka feedback chahiye.', goal: 'Poocho: product quality, scheme samajh aayi ya nahi, payment time pe mila ya nahi. Summary mein unki baat likho.' },
    pa: { first: 'Sat Sri Akal {name} ji, {brand} ton. Do minute tuhada feedback chahida.', goal: 'Product quality, scheme, payment bare puchho.' },
    en: { first: 'Hello {name}, this is {brand}. Could I take two minutes for your feedback?', goal: 'Ask about product quality, scheme clarity and payout speed. Summarise their answers.' },
  },
};

const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));

export function buildScript({ script, language, vars }) {
  const t = T[script]?.[language] || T[script]?.hi;
  return {
    firstMessage: fill(t.first, vars),
    instructions: `${fill(t.goal, vars)} Call ke end mein outcome batao: INTERESTED, NOT_INTERESTED, NO_ANSWER, WRONG_NUMBER, CALL_LATER ya DO_NOT_CALL (agar woh dobara call nahi chahte). Ek line ka summary do.`,
  };
}
