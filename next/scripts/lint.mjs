// Additional safety/architecture checks. Compiler checks handle types and unused symbols.
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
let errors=0;
function report(path,rule){console.error(`${path}: ${rule}`);errors++;}
function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){
 const path=join(dir,item.name);if(item.isDirectory())walk(path);else if(path.endsWith('.ts')){
  const source=readFileSync(path,'utf8');const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  for(const diagnostic of file.parseDiagnostics)report(path,ts.flattenDiagnosticMessageText(diagnostic.messageText,' '));
  if(/@ts-(ignore|nocheck)/.test(source))report(path,'Type checking bypass is not permitted');
  function visit(node){
   if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
    const spec=node.moduleSpecifier.text;
    if(spec.includes('/../../../')||spec.startsWith('../../../'))report(path,'Do not import the legacy wr package');
    if(path.includes('domain/')&&(/node:(fs|child_process|http)/.test(spec)))report(path,'Domain must not perform external side effects');
   }
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='eval')report(path,'eval is prohibited');
   ts.forEachChild(node,visit);
  }visit(file);
 }
}}
walk('src');if(errors)process.exitCode=1;else console.log('Safety/architecture lint passed');
