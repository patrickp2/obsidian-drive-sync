import { DriveStore } from './drive';
import { equalContent } from './content';
import { StaleWrite } from './sync';
import type { ProbeReport, ProbeTransport } from './drive-probe';
/** Only creates and modifies this invocation's synthetic files and folders. */
export async function runLifecycleProbe(send: ProbeTransport, progress: (message: string) => void): Promise<ProbeReport> {
  const report: ProbeReport = { folderName: `Drive Sync lifecycle test ${crypto.randomUUID()}`, checks: [], passed: false, cleanup: '' };
  const roots: string[] = [];
  const check = (message: string) => { report.checks.push(message); progress(message); };
  const expect = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
  const stale = async (work: () => Promise<void>, name: string) => {
    try { await work(); } catch (error) { if (error instanceof StaleWrite) { check(`PASS: stale ${name} rejected with HTTP 412.`); return; } throw error; }
    throw new Error(`FAIL: stale ${name} was accepted. Do not enable automatic move/trash.`);
  };
  try {
    for (const suffix of ['Work', 'Personal']) {
      const root = await DriveStore.reserveId(send); roots.push(root);
      await DriveStore.createFolder(send, `${report.folderName} - ${suffix}`, root);
    }
    const work = new DriveStore(send, roots[0]!); const personal = new DriveStore(send, roots[1]!);
    await work.list(); await personal.list();
    const id = await work.reserveId(), other = await personal.reserveId();
    const a = Uint8Array.from({ length: 4096 }, (_, i) => i % 256).buffer;
    const b = Uint8Array.of(255, 0, 128, 13, 10, 254).buffer;
    await work.create('assets/sample.bin', a, id); await personal.create('assets/sample.bin', b, other);
    const [wf, pf] = await Promise.all([work.list(), personal.list()]);
    expect(wf.length === 1 && wf[0]!.id === id && pf.length === 1 && pf[0]!.id === other, 'Vault folder listings leaked across roots.');
    expect(equalContent((await work.read(wf[0]!)).content, a) && equalContent((await personal.read(pf[0]!)).content, b), 'Binary readback differs.');
    check('PASS: two Drive folders keep identical paths isolated; binary uploads preserve all byte values.');
    const file = wf[0]!; const first = await work.read(file);
    await work.update(file, b, first.etag); expect(equalContent((await work.read(file)).content, b), 'Binary replacement differs.');
    await stale(() => work.update(file, a, first.etag), 'binary replacement');
    await stale(() => work.move(file, 'moved/stale.bin', first.etag), 'rename/move');
    expect((await work.list())[0]?.path === 'assets/sample.bin', 'Rejected move changed the path.');
    const latest = await work.read(file);
    await work.move(file, 'moved/renamed.bin', latest.etag);
    const moved = (await work.list())[0]!;
    expect(moved.id === id && moved.path === 'moved/renamed.bin' && equalContent((await work.read(moved)).content, b), 'Current move did not preserve ID/bytes.');
    check('PASS: current-ETag rename and parent move preserve identity and content.');
    await stale(() => work.trash(moved, latest.etag), 'trash');
    expect((await work.list()).length === 1, 'Rejected trash removed the file.');
    const final = await work.read(moved); await work.trash(moved, final.etag);
    expect((await work.list()).length === 0 && await work.missing(id) === 'trashed', 'Current trash was not confirmed.');
    expect(equalContent((await personal.read(pf[0]!)).content, b), 'Other vault was changed.');
    check('PASS: current-ETag trash is confirmed; other vault remains unchanged.');
    report.passed = true;
  } catch (error) { check(error instanceof Error ? error.message : 'Lifecycle probe interrupted.'); }
  finally {
    let cleaned = true;
    for (const root of roots) {
      try {
        const response = await send({ url: `https://www.googleapis.com/drive/v3/files/${root}`, method: 'PATCH', contentType: 'application/json', body: '{"trashed":true}' });
        if (response.status !== 200) cleaned = false;
      } catch { cleaned = false; }
    }
    report.cleanup = cleaned ? 'Synthetic test folders moved to Drive trash; nothing permanently deleted.' : `Cleanup incomplete. Check Drive for ${report.folderName}.`;
  }
  return report;
}
