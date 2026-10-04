import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingKey, seal, unseal, invitationLink, parseInvitation, receivePairing, validateConfig } from '../src/pairing';
const config = { clientId: 'synthetic.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret', folderId: 'synthetic-folder' };
test('pairing authenticates both directions and transfers only configuration', async () => {
  const invitation = { address: '192.168.1.12', port: 54321, key: pairingKey(), session: crypto.randomUUID() };
  assert.deepEqual(parseInvitation(invitationLink(invitation)), invitation);
  const received = await receivePairing(invitation, async (url, body) => {
    assert.match(url, /^http:\/\/192\.168\.1\.12:54321\/pair\//);
    assert.equal(body.includes(config.clientSecret), false);
    const request = await unseal(invitation.key, invitation.session, 'request', JSON.parse(body)) as { nonce: string };
    return JSON.stringify(await seal(invitation.key, invitation.session, 'response', { nonce: request.nonce, config: { ...config, refreshToken: 'never-import' } }));
  });
  assert.deepEqual(received, config); assert.equal('refreshToken' in received, false);
});
test('wrong key, session, reflected messages, and replayed responses fail authentication', async () => {
  const key = pairingKey(); const session = crypto.randomUUID(); const encrypted = await seal(key, session, 'request', config);
  await assert.rejects(unseal(pairingKey(), session, 'request', encrypted));
  await assert.rejects(unseal(key, crypto.randomUUID(), 'request', encrypted));
  await assert.rejects(unseal(key, session, 'response', encrypted));
  const invitation = { address: '10.0.0.2', port: 5000, key, session };
  await assert.rejects(receivePairing(invitation, async () => JSON.stringify(await seal(key, session, 'response', { nonce: 'wrong-request', config }))), /did not match/);
});
test('invitations reject public endpoints, credentials, duplicate keys and invalid ports', () => {
  const invitation = { address: '192.168.1.12', port: 54321, key: pairingKey(), session: crypto.randomUUID() };
  for (const address of ['8.8.8.8', '127.0.0.1', '192.168.1.999', 'example.com', '169.254.169.254']) assert.throws(() => parseInvitation(invitationLink({ ...invitation, address })));
  assert.throws(() => parseInvitation(invitationLink({ ...invitation, port: 80 })));
  assert.throws(() => parseInvitation(invitationLink(invitation) + '&key=duplicate'));
  assert.throws(() => validateConfig({ ...config, clientSecret: '' }));
});
