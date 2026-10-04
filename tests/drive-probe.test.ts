import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDriveProbe, type ProbeRequest, type ProbeResponse } from '../src/drive-probe';

function server(options: { ignorePrecondition?: boolean; missingEtag?: boolean; cleanupFails?: boolean; corruptDownload?: boolean } = {}) {
  const calls: ProbeRequest[] = [];
  let content = ''; let version = 1;
  const respond = (status: number, text: string, headers: Record<string, string> = {}): ProbeResponse => ({ status, text, headers });
  const send = async (request: ProbeRequest) => {
    calls.push(request);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://www.googleapis.com');
    if (request.method === 'POST') {
      if (url.searchParams.get('uploadType') === 'multipart') {
        content = (request.body as string).split('Content-Type: text/markdown; charset=UTF-8\r\n\r\n')[1]!.split('\r\n--')[0]!;
        assert.equal(JSON.parse((request.body as string).split('\r\n\r\n')[1]!.split('\r\n--')[0]!).parents[0], 'created-folder');
        return respond(200, '{"id":"created-file"}');
      }
      return respond(200, '{"id":"created-folder"}');
    }
    assert.ok(['/drive/v3/files/created-file', '/drive/v3/files/created-folder', '/upload/drive/v3/files/created-file'].includes(url.pathname));
    if (request.method === 'GET') {
      return url.searchParams.get('alt') === 'media'
        ? respond(200, options.corruptDownload ? 'bad' : content)
        : respond(200, JSON.stringify({ version: String(version) }), options.missingEtag ? {} : { ETag: `"v${version}"` });
    }
    if (request.body === '{"trashed":true}') return respond(options.cleanupFails ? 503 : 200, '{}');
    assert.equal(url.searchParams.get('uploadType'), 'media');
    if (!options.ignorePrecondition && request.headers?.['If-Match'] && request.headers['If-Match'] !== `"v${version}"`) return respond(412, '{}');
    content = request.body as string; version++;
    return respond(200, '{}');
  };
  return { send, calls };
}

test('probe requires current update success, stale rejection, preserved bytes, and successful fresh update', async () => {
  const fake = server(); const result = await runDriveProbe(fake.send);
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 5);
  assert.match(result.cleanup, /All test resources moved/);
  const edits = fake.calls.filter(call => call.url.includes('uploadType=media'));
  assert.deepEqual(edits.map(call => call.headers?.['If-Match']), ['"v1"', '"v1"', '"v2"']);
  assert.deepEqual(fake.calls.slice(-2).map(call => new URL(call.url).pathname), ['/drive/v3/files/created-file', '/drive/v3/files/created-folder']);
});
test('a backend ignoring If-Match cannot pass, and cleanup still runs', async () => {
  const fake = server({ ignorePrecondition: true }); const result = await runDriveProbe(fake.send);
  assert.equal(result.passed, false); assert.match(result.checks.at(-1)!, /HTTP 200, expected 412/);
  assert.match(result.cleanup, /All test resources moved/);
});
test('missing ETag never passes safety even if a fabricated precondition is rejected', async () => {
  const fake = server({ missingEtag: true }); const result = await runDriveProbe(fake.send);
  assert.equal(result.passed, false);
  assert.match(result.checks.at(-1)!, /Conditional edit remains unproven/);
  assert.match(result.checks.at(-1)!, /HTTP 412/);
});
test('missing ETag plus ignored fabricated precondition reports unsafe replacement', async () => {
  const result = await runDriveProbe(server({ missingEtag: true, ignorePrecondition: true }).send);
  assert.equal(result.passed, false); assert.match(result.checks.at(-1)!, /UNSAFE: media PATCH accepted/);
});
test('content mismatch fails even when HTTP requests succeed', async () => {
  const fake = server({ corruptDownload: true }); const result = await runDriveProbe(fake.send);
  assert.equal(result.passed, false); assert.match(result.checks.at(-1)!, /content did not match/);
});
test('cleanup failure remains visible independently of passed content checks', async () => {
  const result = await runDriveProbe(server({ cleanupFails: true }).send);
  assert.equal(result.passed, true); assert.match(result.cleanup, /Cleanup incomplete/);
});
test('unknown creation outcomes are not retried or misreported as cleaned', async () => {
  let count = 0;
  const result = await runDriveProbe(async () => { count++; throw new Error('sensitive-provider-body'); });
  assert.equal(count, 1); assert.equal(result.passed, false);
  assert.match(result.cleanup, /creation outcome unknown/);
  assert.equal(JSON.stringify(result).includes('sensitive-provider-body'), false);
});
