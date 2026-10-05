from pathlib import Path
import json,subprocess,sys,csv,io
root=Path(sys.argv[1]);spec={'format':'afterlife/v1','app_id':'csv-roundtrip','title':'CSV exact typed records','fields':[{'name':'title','label':'Title','type':'text','required':True},{'name':'notes','label':'Notes','type':'multiline'},{'name':'hours','label':'Hours','type':'integer'},{'name':'active','label':'Active','type':'boolean'},{'name':'state','label':'State','type':'select','options':['open','done']}]};records=[{'id':'0001','title':'=literal formula','notes':'PRIVATE <img src="https://invalid.example">\r\n猫, "quoted"','hours':9007199254740991,'active':False,'state':'open'},{'id':"'apostrophe",'title':' Exact title ','notes':'','hours':None,'active':True,'state':'done'}]
def cli(*args):return subprocess.run([sys.executable,'-m','afterlife',*map(str,args)],capture_output=True,text=True)
if len(sys.argv)==2:
 (root/'spec.json').write_text(json.dumps(spec));(root/'records.json').write_text(json.dumps(records))
else:
 source=root/'input.csv';before=source.read_bytes();out=root/'backup.json';r=cli('import-csv',root/'spec.json',source,'--text-policy','afterlife','-o',out);assert r.returncode==0,r.stderr;backup=json.loads(out.read_text());assert backup['records']==records and'PRIVATE'not in r.stdout;old=out.read_bytes()
 r=cli('from-export',root/'spec.json',out,'-o',root/'app.html');assert r.returncode==0,r.stderr
 # Every late failure leaves the already existing output byte for byte intact.
 for bad in [before+b"bad,row\r\n",before.replace(b'9007199254740991',b'9007199254740992'),before.replace(b'false',b'0'),before.replace(b'\"hours\"',b'\"missing\"'),before.replace(b'\"\'0001\"',b'\"0001\"')]:
  source.write_bytes(bad);r=cli('import-csv',root/'spec.json',source,'--text-policy','afterlife','-o',out,'--force');assert r.returncode==2 and not r.stdout;assert out.read_bytes()==old
 source.write_bytes(before);r=cli('import-csv',root/'spec.json',source,'--text-policy','afterlife','-o',source,'--force');assert r.returncode==2 and source.read_bytes()==before
 stream=io.StringIO(newline='');writer=csv.writer(stream);writer.writerow(['id',*[f['name']for f in spec['fields']]]);writer.writerows([[r[k]if r[k]is not None else''for k in ['id','title','notes','hours','active','state']]for r in records]);literal=stream.getvalue().replace(',False,',',false,').replace(',True,',',true,');source.write_text(literal,newline='');r=cli('import-csv',root/'spec.json',source,'--text-policy','literal','-o',out,'--force');assert r.returncode==0,r.stderr;assert json.loads(out.read_text())['records']==records
