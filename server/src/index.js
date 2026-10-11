// Cloudflare Worker entry point. Each person's inbox is one Durable Object; the
// Worker routes requests and calls the inbox over RPC.
import { DurableObject } from 'cloudflare:workers';
import { InboxCore, handleRequest } from './core.js';

export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new InboxCore(ctx.storage);
  }

  init(readKeyHash, sendSecretHash) { return this.core.init(readKeyHash, sendSecretHash); }
  list(readKey) { return this.core.list(readKey); }
  ack(readKey, ids) { return this.core.ack(readKey, ids); }
  rotate(readKey) { return this.core.rotate(readKey); }
  disable(readKey) { return this.core.disable(readKey); }
  canSend(sendSecret) { return this.core.canSend(sendSecret); }
  deliver(sendSecret, recipe) { return this.core.deliver(sendSecret, recipe); }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
