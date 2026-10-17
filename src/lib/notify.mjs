import { log } from './util.mjs';

/** Push through Home Assistant's notify service via the Supervisor proxy. */
export async function notify(options, title, message) {
  log('notify', `${title}: ${message}`);
  const token = options.supervisorToken;
  const service = (options.notify_service || '').replace(/^notify\./, '');
  if (!token || !service) return;
  try {
    await fetch(`http://supervisor/core/api/services/notify/${service}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title, message }),
    });
  } catch (err) {
    log('notify', `delivery failed: ${err.message}`);
  }
}
