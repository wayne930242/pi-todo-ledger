import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, snapshots, text } from './harness.ts';

test('uids survive updates, branch replay and handover; legacy tasks get no invented uid', async t => {
 const source = load();
 await source.call({action:'create', subject:'single', evidence:[{command:'test',result:'pass',ref:'child:abc'}]});
 await source.call({action:'create', tasks:[{subject:'batch1'},{subject:'batch2'}]});
 const saved = snapshots(source.branch).at(-1)!;
 const ids = saved.tasks.map(task => task.uid);
 for (const uid of ids) assert.match(String(uid), /^t_[a-z2-7]{10}$/);
 assert.equal(new Set(ids).size, 3);
 assert.equal((saved.tasks[0]!.evidence as {ref:string}[])[0]!.ref, 'child:abc');
 await source.call({action:'update',id:1,owner:'me'});
 assert.deepEqual(snapshots(source.branch).at(-1)!.tasks.map(task => task.uid), ids);
 await source.fire('session_tree');
 assert.deepEqual((source.events('todo:changed').at(-1) as typeof saved).tasks.map(task => task.uid), ids);
 const cwd = mkdtempSync(join(tmpdir(),'todo-identity-'));
 t.after(() => rmSync(cwd,{recursive:true,force:true}));
 delete saved.tasks[2]!.uid;
 writeFileSync(join(cwd,'snapshot.json'), JSON.stringify(saved));
 const dest = load({cwd});
 assert.equal(text(await dest.call({action:'import',path:'snapshot.json'})), 'Imported 3 tasks');
 assert.deepEqual(snapshots(dest.branch)[0]!.tasks, saved.tasks.map(task => ({...task,origin:{session:source.sessionId}})));
});

test('invalid evidence references are refused before commit', async () => {
 const h = load();
 for (const ref of ['has space','has\ttab','x'.repeat(65),9]) {
  assert.match(text(await h.call({action:'create',subject:'x',evidence:[{command:'x',result:'pass',ref}]})), /Error:.*ref/);
 }
 assert.equal(snapshots(h.branch).length,0);
});
