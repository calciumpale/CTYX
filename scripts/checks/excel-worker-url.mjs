import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const directory=resolve(process.argv[2]||'dist/client/_next/static/chunks');
const files=await readdir(directory);
let loader;
for(const name of files.filter(name=>/^knowledge-excel-.*\.js$/.test(name))) {
  if((await readFile(resolve(directory,name),'utf8')).includes('importKnowledgeExcel')) {loader=name;break;}
}
assert.ok(loader,'Build must emit the public Excel loader');
// Exercise the production loader, not just the worker entrypoint. No browser or network is used.
const created=[];
globalThis.Worker=class {
  constructor(url,options){created.push({url:String(url),options});}
  postMessage(){queueMicrotask(()=>this.onmessage?.({data:{result:{text:'verified',warnings:[]}}}));}
  terminate(){}
};
// Isolate app-wide preload/bootstrap imports; execute the emitted loader and worker factory unchanged.
const {SourceTextModule,SyntheticModule,createContext}=await import('node:vm');
assert.ok(SourceTextModule,'Run with --experimental-vm-modules');
const context=createContext({Worker:globalThis.Worker,File,Uint8Array,URL,setTimeout,clearTimeout,queueMicrotask});
const cache=new Map();
const preload=new SyntheticModule(['t'],function(){this.setExport('t',async load=>load());},{context});
await preload.link(()=>{});await preload.evaluate();
async function load(name){
 const path=resolve(directory,name);
 if(cache.has(path))return cache.get(path);
 const source=await readFile(path,'utf8');
 const mod=new SourceTextModule(source,{context,identifier:path,initializeImportMeta(meta){meta.url='https://workbench.example/_next/static/chunks/'+name;},importModuleDynamically:async specifier=>{const child=await load(specifier);if(child.status==='linked')await child.evaluate();return child;}});
 cache.set(path,mod);
 await mod.link(async specifier=>specifier.startsWith('./index-')?preload:load(specifier));
 return mod;
}
const emittedModule=await load(loader);await emittedModule.evaluate();
const result=await emittedModule.namespace.importKnowledgeExcel(new File(['fixture'],'fixture.xlsx'),'xlsx');
assert.equal(result.text,'verified');
assert.equal(created.length,1,'Create exactly one parser worker');
const url=new URL(created[0].url,'https://workbench.example/');
assert.equal(url.protocol,'https:','Worker must use the page HTTPS origin, never a build-machine file URL');
assert.equal(url.origin,'https://workbench.example');
assert.match(url.pathname,/^\/_next\/static\/knowledge-excel-worker-.*\.js$/);
await readFile(resolve(directory,'../../..',url.pathname.slice(1)));
assert.equal(created[0].options?.type,'module');
console.log('Production Excel loader creates one module Worker on the page origin.');
