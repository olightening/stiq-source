// Unit tests for relay acknowledgement of organizer mailbox responses.
// Run: node mailbox_publish_test.mjs
import {createResponsePublisher} from './mailbox.mjs';

let failures = 0;
function check(label, condition) {
  console.log((condition ? '  ok   ' : '  FAIL ') + label);
  if (!condition) failures += 1;
}
async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}
class FakeSocket {
  sent = [];
  send(raw, callback) {
    this.sent.push(JSON.parse(raw));
    callback?.();
  }
}

{
  const publisher = createResponsePublisher(100);
  const ws = new FakeSocket();
  const event = {id: 'accepted'};
  const pending = publisher.publish(ws, event);
  check('publish sends the response event', ws.sent[0]?.[0] === 'EVENT' && ws.sent[0]?.[1]?.id === event.id);
  check('matching OK is consumed', publisher.handleMessage(ws, ['OK', event.id, true, 'saved']) === true);
  await pending;
  check('accepted relay OK resolves the publish', true);
}

{
  const publisher = createResponsePublisher(100);
  const ws = new FakeSocket();
  const pending = publisher.publish(ws, {id: 'rejected'});
  publisher.handleMessage(ws, ['OK', 'rejected', false, 'blocked: insufficient proof-of-work']);
  const error = await rejection(pending);
  check('relay rejection rejects the publish', /insufficient proof-of-work/.test(error?.message || ''));
}

{
  const publisher = createResponsePublisher(10);
  const ws = new FakeSocket();
  const error = await rejection(publisher.publish(ws, {id: 'timeout'}));
  check('missing relay OK times out instead of pretending delivery', /acknowledge.*time/i.test(error?.message || ''));
}

{
  const publisher = createResponsePublisher(100);
  const ws = new FakeSocket();
  const pending = publisher.publish(ws, {id: 'closed'});
  publisher.failSocket(ws, new Error('relay socket closed'));
  const error = await rejection(pending);
  check('socket closure rejects pending response publishes', /socket closed/i.test(error?.message || ''));
}

console.log(failures === 0 ? '\nall mailbox publish tests passed' : `\n${failures} mailbox publish test(s) FAILED`);
if (failures > 0) process.exit(1);
