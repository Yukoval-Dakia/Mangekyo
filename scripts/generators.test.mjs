import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {generateModule} from './new-module.mjs';
import {generateDeriver} from './new-deriver.mjs';
let root;
afterEach(async()=>{if(root) await rm(root,{recursive:true,force:true});});
it('failed creation never removes existing derivers or samples',async()=>{
 root=await mkdtemp(path.join(tmpdir(),'mangekyo-generator-'));
 await generateModule('sample',root);
 const existing=path.join(root,'modules/sample/derivers/count-note.ts');
 const content=await readFile(existing,'utf8');
 // An existing non-directory forces a failure after the derivers directory was inspected.
 await rm(path.join(root,'modules/sample/samples'),{recursive:true});
 await writeFile(path.join(root,'modules/sample/samples'),'occupied');
 await expect(generateDeriver('sample','new-one',root)).rejects.toThrow();
 expect(await readFile(existing,'utf8')).toBe(content);
 expect(await readFile(path.join(root,'modules/sample/samples'),'utf8')).toBe('occupied');
});
