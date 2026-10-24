/** PDF.js requests only these bundled, same-origin font maps; never document-supplied URLs. */
const cMaps=import.meta.glob('../../node_modules/pdfjs-dist/cmaps/*.bcmap',{query:'?url',import:'default'});
const fonts=import.meta.glob('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',{query:'?url',import:'default'});

export class ContractPdfBinaryDataFactory {
  async fetch({kind,filename}:{kind:string;filename:string}):Promise<Uint8Array> {
    if(!/^[A-Za-z0-9_.-]+$/.test(filename))throw new Error('PDF 内置字体名称无效。');
    const prefix=kind==='cMapUrl'?'../../node_modules/pdfjs-dist/cmaps/':kind==='standardFontDataUrl'?'../../node_modules/pdfjs-dist/standard_fonts/':'';
    const load=(kind==='cMapUrl'?cMaps:fonts)[prefix+filename];
    if(!prefix||!load)throw new Error('PDF 使用了不支持的字体映射，请转换为 TXT 后重试。');
    const url=await load();
    if(typeof url!=='string')throw new Error('PDF 字体资源加载失败。');
    const response=await fetch(url,{credentials:'same-origin'});
    if(!response.ok)throw new Error('PDF 字体资源加载失败，请刷新页面后重试。');
    return new Uint8Array(await response.arrayBuffer());
  }
}
