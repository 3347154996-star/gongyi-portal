'use strict';
// Read spreadsheet cells without transferring embedded photos from the share.
const fs=require('node:fs/promises'),zlib=require('node:zlib');
const JSZip=require('../public/tools/vendor/jszip.min.js');
const MAX_XML=64*1024*1024,MAX_FILE=512*1024*1024;
async function readSpreadsheetBuffer(filename){
  const handle=await fs.open(filename,'r');
  try{
    const before=await handle.stat();if(before.size<8||before.size>MAX_FILE)throw Error('workbook_size');
    async function read(position,length){if(position<0||length<0||position+length>before.size)throw Error('invalid_zip_range');const buffer=Buffer.alloc(length);let offset=0;while(offset<length){const n=await handle.read(buffer,offset,length-offset,position+offset);if(!n.bytesRead)throw Error('workbook_changed');offset+=n.bytesRead;}return buffer;}
    const magic=await read(0,8);let result;
    if(magic.readUInt32LE(0)!==0x04034b50){if(before.size>64*1024*1024)throw Error('legacy_workbook_size');result=await read(0,before.size);}
    else{
      const tail=await read(Math.max(0,before.size-65557),Math.min(before.size,65557));let end=-1;
      for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
      if(end<0||tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6))throw Error('unsupported_zip');
      const count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
      if(count===65535||length>8*1024*1024||count>10000)throw Error('zip_limit');
      const directory=await read(offset,length),zip=new JSZip();let p=0,total=0;
      for(let i=0;i<count;i++){
        if(p+46>directory.length||directory.readUInt32LE(p)!==0x02014b50)throw Error('invalid_zip');
        const flags=directory.readUInt16LE(p+8),method=directory.readUInt16LE(p+10),compressed=directory.readUInt32LE(p+20),size=directory.readUInt32LE(p+24),nameLength=directory.readUInt16LE(p+28),extra=directory.readUInt16LE(p+30),comment=directory.readUInt16LE(p+32),local=directory.readUInt32LE(p+42);
        const name=directory.subarray(p+46,p+46+nameLength).toString('utf8');p+=46+nameLength+extra+comment;
        const selected=name==='[Content_Types].xml'||name==='_rels/.rels'||(/^xl\/.+\.(?:xml|rels)$/.test(name)&&!/^xl\/(?:media|drawings|charts)\//.test(name));
        if(!selected)continue;if(flags&1||![0,8].includes(method)||size>MAX_XML||(total+=size)>MAX_XML||compressed>MAX_XML)throw Error('unsupported_workbook');
        const header=await read(local,30);if(header.readUInt32LE(0)!==0x04034b50)throw Error('invalid_zip');
        const packed=await read(local+30+header.readUInt16LE(26)+header.readUInt16LE(28),compressed);
        const data=method===8?zlib.inflateRawSync(packed,{maxOutputLength:MAX_XML}):packed;if(data.length!==size)throw Error('invalid_zip_size');
        zip.file(name,data,{date:new Date('1980-01-01T00:00:00Z'),createFolders:false});
      }
      if(!zip.file('xl/workbook.xml'))throw Error('missing_workbook');
      result=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});
    }
    const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('workbook_changed');return result;
  }finally{await handle.close();}
}
module.exports={readSpreadsheetBuffer};
