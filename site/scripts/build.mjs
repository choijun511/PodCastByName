import {build} from 'esbuild';
import {readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
const assets={};
for(const name of await readdir('public')){
 if(!/^(index\.html|app\.js|style\.css|explore\.js|explore\.css|connection\.js|admin\.html|admin\.js|admin\.css)$/.test(name))throw Error('Unexpected public asset: '+name);
 assets['/'+name]={body:await readFile('public/'+name,'utf8'),type:name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'};
}
let source=await readFile('worker/index.js','utf8');
source=source.replace("import catalog from './catalog.json' with {type:'json'};",'const catalog='+await readFile('worker/catalog.json','utf8')+';').replace("import assets from './assets.json' with {type:'json'};",'const assets='+JSON.stringify(assets)+';');
await rm('dist',{recursive:true,force:true});await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});
await build({stdin:{contents:source,resolveDir:process.cwd()+'/worker',sourcefile:'index.js',loader:'js'},bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/server/index.js'});await writeFile('dist/.openai/hosting.json',await readFile('.openai/hosting.json'));
console.log('Built self-contained Worker with '+Object.keys(assets).length+' public assets.');
