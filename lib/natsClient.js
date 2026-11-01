const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function createBus(url, name = 'client') {
  const { connect, StringCodec } = require('nats');
  const codec = StringCodec();
  const subscriptions = [];
  let connection = null;
  let up = false;
  let closing = false;

  function listen(subject, handler) {
    const subscription = connection.subscribe(subject);
    (async () => {
      for await (const message of subscription) {
        try {
          handler(JSON.parse(codec.decode(message.data)), message.subject);
        } catch (err) {
          console.error(`[${name}] failed to handle ${message.subject}: ${err.message}`);
        }
      }
    })();
  }

  async function open() {
    while (!closing) {
      try {
        connection = await connect({
          servers: url,
          name,
          maxReconnectAttempts: -1,
          reconnectTimeWait: 1000
        });
        break;
      } catch (err) {
        console.error(`[${name}] nats connect failed: ${err.message}`);
        await wait(1000);
      }
    }
    if (closing) return;

    up = true;
    console.log(`[${name}] nats connected`);
    subscriptions.forEach(item => listen(item.subject, item.handler));

    for await (const status of connection.status()) {
      if (status.type === 'disconnect') {
        up = false;
        console.warn(`[${name}] nats disconnected`);
      }
      if (status.type === 'reconnect') {
        up = true;
        console.log(`[${name}] nats reconnected`);
      }
    }
  }

  open();

  return {
    get connected() {
      return up;
    },
    publish(subject, payload) {
      if (!connection || !up) return false;
      try {
        connection.publish(subject, codec.encode(JSON.stringify(payload)));
        return true;
      } catch (err) {
        return false;
      }
    },
    subscribe(subject, handler) {
      subscriptions.push({ subject, handler });
      if (connection) listen(subject, handler);
    },
    async close() {
      closing = true;
      up = false;
      if (connection) await connection.drain().catch(() => {});
    }
  };
}

module.exports = { createBus };
