// Explicit, synthetic-data-only experiment. This is not the sync adapter.
export interface ProbeRequest {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
}
export interface ProbeResponse { status: number; headers: Record<string, string>; text: string; arrayBuffer?: ArrayBuffer }
export type ProbeTransport = (request: ProbeRequest) => Promise<ProbeResponse>;
export interface ProbeReport { folderName: string; checks: string[]; passed: boolean; cleanup: string }
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,version,md5Checksum';
const A = '# Disposable Drive Sync test\n\nBaseline A — café 📱\n';
const B = '# Disposable Drive Sync test\n\nSaved edit B — café 📱\n';
const C = '# Disposable Drive Sync test\n\nCompeting edit C — café 📱\n';

class ProbeFailure extends Error {}
function expect(ok: unknown, message: string): asserts ok { if (!ok) throw new ProbeFailure(message); }
function json(response: ProbeResponse): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(response.text);
    expect(value && typeof value === 'object' && !Array.isArray(value), 'Invalid metadata response.');
    return value as Record<string, unknown>;
  } catch { throw new ProbeFailure('Invalid metadata response.'); }
}
function id(response: ProbeResponse): string {
  expect(response.status === 200 || response.status === 201, `Create failed (HTTP ${response.status}).`);
  const value = json(response).id;
  expect(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'Missing test resource ID.');
  return value;
}
function etag(response: ProbeResponse): string {
  const value = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'etag')?.[1];
  expect(typeof value === 'string' && /^"[^"\r\n]+"$/.test(value), 'No strong metadata ETag available; conditional writes remain unproven.');
  return value;
}
function optionalEtag(response: ProbeResponse): string | undefined {
  try { return etag(response); } catch { return undefined; }
}

/** Every mutation targets a resource created by this invocation; never accepts a vault path or existing Drive ID. */
export async function runDriveProbe(send: ProbeTransport, progress: (message: string) => void = () => {}, version: 'v3' | 'v2' = 'v3'): Promise<ProbeReport> {
  const run = crypto.randomUUID();
  const report: ProbeReport = { folderName: `Drive Sync disposable test ${run}`, checks: [], passed: false, cleanup: 'No resources created.' };
  const created: string[] = [];
  let creationUncertain = false;
  const check = (message: string) => { report.checks.push(message); progress(message); };
  const create = async (request: ProbeRequest) => {
    // No automatic retry of a create with an unknown outcome: avoid duplicates.
    creationUncertain = true;
    const response = await send(request);
    const resource = id(response);
    created.push(resource);
    creationUncertain = false;
    return resource;
  };
  const read = async (file: string, content: string) => {
    const response = await send({ url: `${API}/${file}?alt=media`, method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
    expect(response.status === 200 && response.text === content, `Downloaded content did not match the expected test edit (HTTP ${response.status}).`);
    return optionalEtag(response);
  };
  const metadata = async (file: string) => {
    const response = await send({ url: `${API.replace('/v3/', `/${version}/`)}/${file}?fields=${FIELDS}${version === 'v2' ? ',etag' : ''}`, method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
    expect(response.status === 200, `Metadata read failed (HTTP ${response.status}).`);
    const data = json(response);
    const bodyEtag = typeof data.etag === 'string' && /^"[^"\r\n]+"$/.test(data.etag) ? data.etag : undefined;
    return { etag: optionalEtag(response) ?? bodyEtag, version: data.version };
  };
  const edit = (file: string, tag: string, content: string) => send({
    url: `${UPLOAD.replace('/v3/', `/${version}/`)}/${file}?uploadType=media&fields=${FIELDS}`, method: version === 'v2' ? 'PUT' : 'PATCH',
    headers: { 'If-Match': tag }, contentType: 'text/markdown; charset=UTF-8', body: content
  });
  try {
    check(`Testing ${version} metadata and ${version === 'v2' ? 'PUT' : 'PATCH'} media upload.`);
    progress('Creating a disposable folder and synthetic Markdown file…');
    const folder = await create({ url: API, method: 'POST', contentType: 'application/json',
      body: JSON.stringify({ name: report.folderName, mimeType: 'application/vnd.google-apps.folder' }) });
    const boundary = `drive_sync_${run}`;
    const file = await create({ url: `${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, method: 'POST',
      contentType: `multipart/related; boundary=${boundary}`,
      body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: 'edit-test.md', mimeType: 'text/markdown', parents: [folder] })}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${A}\r\n--${boundary}--\r\n` });
    const mediaEtag = await read(file, A);
    check('PASS: uploaded and downloaded baseline A, including Unicode.');
    const baseline = await metadata(file);
    baseline.etag ??= mediaEtag;
    if (!baseline.etag) {
      // Only this invocation's disposable file is eligible for this diagnostic
      // unconditional update. It must never become a production fallback.
      const basic = await send({ url: `${UPLOAD}/${file}?uploadType=media&fields=${FIELDS}`, method: 'PATCH',
        contentType: 'text/markdown; charset=UTF-8', body: B });
      expect(basic.status === 200, `Basic disposable edit failed (HTTP ${basic.status}).`);
      await read(file, B);
      check('PASS: basic edit B uploaded and downloaded. No strong metadata or content ETag was returned.');
      const invalid = await edit(file, `"drive-sync-nonmatching-${run}"`, C);
      if (invalid.status === 200) {
        await read(file, C);
        throw new ProbeFailure('UNSAFE: media PATCH accepted a deliberately nonmatching If-Match (HTTP 200) and replaced the disposable content. Automatic replacement stays disabled.');
      }
      await read(file, B);
      throw new ProbeFailure(`Conditional edit remains unproven: no strong ETag was returned; a deliberately nonmatching If-Match returned HTTP ${invalid.status}. Edit B was preserved.`);
    }
    expect(typeof baseline.version === 'string' && /^\d+$/.test(baseline.version), 'Missing baseline version.');
    const edited = await edit(file, baseline.etag, B);
    expect(edited.status === 200, `Current-ETag update failed (HTTP ${edited.status}).`);
    const editedMediaEtag = await read(file, B);
    const latest = await metadata(file);
    latest.etag ??= editedMediaEtag;
    expect(latest.etag, 'No strong ETag returned after edit; conditional updates remain unproven.');
    expect(latest.etag !== baseline.etag && typeof latest.version === 'string' && /^\d+$/.test(latest.version) &&
      BigInt(latest.version) > BigInt(baseline.version), 'Edit did not advance the ETag and version.');
    check('PASS: edit B saved using the current ETag; content, ETag, and version verified.');
    // Models two clients that both read A: one writes B; the other tries C using A's ETag.
    const stale = await edit(file, baseline.etag, C);
    expect(stale.status === 412, `UNSAFE OR INCONCLUSIVE: stale edit returned HTTP ${stale.status}, expected 412. Automatic replacement stays disabled.`);
    await read(file, B);
    check('PASS: stale edit C rejected with HTTP 412; edit B preserved.');
    const retry = await edit(file, latest.etag, C);
    expect(retry.status === 200, `Fresh-ETag update failed (HTTP ${retry.status}).`);
    await read(file, C);
    check('PASS: edit C accepted with the current ETag and downloaded correctly.');
    report.passed = true;
  } catch (error) {
    check(error instanceof ProbeFailure ? error.message : 'Test interrupted or request failed. Provider responses and credentials are omitted.');
  } finally {
    let cleaned = true;
    for (const resource of [...created].reverse()) {
      try {
        const response = await send({ url: `${API}/${resource}`, method: 'PATCH', contentType: 'application/json', body: '{"trashed":true}' });
        if (response.status !== 200) cleaned = false;
      } catch { cleaned = false; }
    }
    report.cleanup = creationUncertain || !cleaned
      ? `Cleanup incomplete or creation outcome unknown. Check Google Drive for ${report.folderName}.`
      : created.length ? 'All test resources moved to Drive trash; nothing permanently deleted.' : 'No resources created.';
    progress(report.cleanup);
  }
  return report;
}
