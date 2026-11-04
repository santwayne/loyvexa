import { Router } from 'express';
import { config } from '../config.js';
import { ah } from '../lib/errors.js';
import { channelByPhoneNumberId, verifySignature } from '../services/whatsapp.js';
import { handleInbound } from '../services/bot.js';
import { applyStatus } from '../services/campaigns.js';

/** Meta WhatsApp Cloud API webhook. One URL for all brands; routed by phone_number_id. */
const r = Router();

r.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.whatsapp.verifyToken) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});

r.post('/webhook', ah(async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  // Meta expects a fast 200; we still process inline because replies are quick, but never throw back at Meta.
  const jobs = [];
  for (const entry of req.body?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const channel = v.metadata?.phone_number_id ? await channelByPhoneNumberId(v.metadata.phone_number_id) : null;
      if (!channel) continue;
      for (const st of v.statuses || []) jobs.push(applyStatus({ providerMsgId: st.id, status: st.status, error: st.errors?.[0]?.title }));
      for (const m of v.messages || []) {
        const text = m.type === 'text' ? m.text?.body
          : m.type === 'button' ? m.button?.text
            : m.type === 'interactive' ? (m.interactive?.button_reply?.id || m.interactive?.list_reply?.id) : null;
        if (!text) { jobs.push(handleInbound({ channel, from: m.from, text: 'menu', providerMsgId: m.id })); continue; }
        jobs.push(handleInbound({ channel, from: m.from, text, providerMsgId: m.id }));
      }
    }
  }
  await Promise.allSettled(jobs);
  res.sendStatus(200);
}));

export default r;
