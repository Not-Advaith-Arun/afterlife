"""Generate a self-contained, offline product showcase from computed sample data."""
import argparse
import html
import json
import os
import re
import sys
from pathlib import Path
import tempfile


def render(config):
    assets=Path(__file__).with_name('ui')
    raw=json.dumps(config,ensure_ascii=True).replace('<','\\u003c').replace('&','\\u0026')
    replacements={'TITLE':html.escape(config['name']+' — Workbench'),
                  'STYLE':assets.joinpath('style.css').read_text(encoding='utf-8'),
                  'DATA':raw,'SCRIPT':assets.joinpath('app.js').read_text(encoding='utf-8')}
    return re.sub(r'__(TITLE|STYLE|DATA|SCRIPT)__',lambda match:replacements[match.group(1)],
                  assets.joinpath('index.html').read_text(encoding='utf-8'))



def arguments(parser):
    parser.add_argument('-o','--output',type=Path,required=True)
    parser.add_argument('--overview',action='store_true',help='Generate the five-project overview; combine with --collection-links for a local collection')
    parser.add_argument('--force',action='store_true',help='Replace an existing regular output; existing user inputs/stores remain outside this workflow')
    parser.add_argument('--collection-links',action='store_true',help='Use sibling project-name.html links; generate all five project files beside index.html before using this option')


def generate(args):
    try:
        output=args.output
        if output.is_symlink() or (output.exists() and not output.is_file()):
            raise ValueError('showcase output must be a regular file, never a symlink')
        if output.exists() and not args.force:
            raise ValueError('showcase output exists; choose a new path or pass --force')
        if not output.parent.is_dir():
            raise ValueError('showcase output directory must already exist')
        config=({'catalog':True,'name':'Project collection','slug':'collection'} if args.overview else sample())
        config['local_collection']=args.collection_links
        document=render(config)
        descriptor,temporary=tempfile.mkstemp(prefix='.'+output.name+'.',suffix='.pending',dir=output.parent)
        try:
            with os.fdopen(descriptor,'w',encoding='utf-8') as stream:
                stream.write(document);stream.flush();os.fsync(stream.fileno())
            if args.force:
                if output.is_symlink():raise ValueError('refusing symlink output')
                os.replace(temporary,output)
            else:os.link(temporary,output)
        finally:Path(temporary).unlink(missing_ok=True)
        print('Showcase saved: '+str(output))
        return 0
    except (ValueError,OSError) as exc:
        print('showcase: '+str(exc),file=sys.stderr)
        return 2


def main(argv=None):
    parser=argparse.ArgumentParser(description="Generate an offline showcase from fictional inputs and actual computed examples; existing user stores remain untouched.")
    arguments(parser)
    return generate(parser.parse_args(argv))

def sample():
    import base64
    from .compiler import compile_app
    spec={'format':'afterlife/v1','app_id':'afterlife-showcase-fieldwork','title':'Fieldwork','description':'A portable sample project tracker.','record_label':'task','required_capabilities':['crud','search','json-import-export','local-persistence'],'fields':[{'name':'title','label':'Task','type':'text','required':True},{'name':'status','label':'Status','type':'select','required':True,'options':['Planned','In progress','Done']},{'name':'notes','label':'Notes','type':'multiline'},{'name':'hours','label':'Hours','type':'integer'},{'name':'important','label':'Priority','type':'boolean'}]}
    records=[{'id':'sample-1','title':'Map the fieldwork route','status':'Done','notes':'A fictional project sample.','hours':2,'important':False},{'id':'sample-2','title':'Check the equipment','status':'In progress','notes':'Keep the record file with the team.','hours':1,'important':True},{'id':'sample-3','title':'Share the handover','status':'Planned','notes':'Export a portable copy before leaving.','hours':None,'important':False}]
    artifact,manifest=compile_app(spec,{'records':records})
    rows=[{'id':row['id'],'title':row['title'],'subtitle':'Fictional fieldwork tracker','status':row['status'],'tone':'good' if row['status']=='Done' else 'warn' if row['status']=='In progress' else '', 'detail':row['notes']} for row in records]
    state={'label':'The portable app','title':'Three records. A working app in one file.','description':'Open the actual generated app below. Create, edit, search, and export without an account or server.','visual':['A supported data model','Your record collection','An editable HTML file'],'metrics':[{'value':3,'label':'Editable sample records'},{'value':5,'label':'Declared fields'},{'value':1,'label':'Portable HTML file'}],'rows':rows,'output':{'spec':spec,'records':records,'manifest':manifest}}
    return {'name':'Afterlife','slug':'afterlife','icon':'box','color':'#8c6c35','description':'Keep a small record app useful after its server disappears. Compile a supported model and data into an editable HTML file.','sample_title':'An app you can take with you','insight':'The generated file contains the supported record model, data, and editing interface. Its portable copy works without the original server.','steps':[{'title':'Choose the supported model','description':'Use a declared record schema or the narrow Python dataclass adapter.'},{'title':'Compile your records','description':'Generate one self-contained editable HTML artifact with visible limits.'},{'title':'Keep working offline','description':'Edit, search, import, export, and download a portable copy.'}],'features':[{'icon':'file','title':'One file, useful offline','description':'Keep record editing, search, matching views, and exports inside the generated HTML.'},{'icon':'layers','title':'Real model extraction','description':'Extract supported dataclass fields and literal defaults without executing the source module.'},{'icon':'shield','title':'Visible conversion boundaries','description':'Inspect compilation evidence and unsupported behavior rather than assuming whole-application equivalence.'}],'command':'python3 -m afterlife showcase -o afterlife.html','scope':'The embedded sample is actual compiler output. It runs in an isolated preview; download the working app to use browser-local saving outside that preview. Only fictional records are included.','footer':'Supported record behavior is preserved within the declared profile. Authentication, arbitrary backend rules, and external side effects are not converted.','states':[state],'artifact':base64.b64encode(artifact.encode('utf-8')).decode('ascii')}
