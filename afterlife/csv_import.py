"""Strict typed CSV decoding with explicit literal-text policy and exact columns."""
import csv,io,re
from .compiler import CompileError,MAX_BYTES,MAX_RECORDS,read_file,validate_spec,_hash,_canonical
from .transfers import backup_records


def decode_csv_rows(spec,raw,*,text_policy,partial=False):
    spec=validate_spec(spec)
    if text_policy not in ('literal','afterlife'):raise CompileError('choose explicit literal or afterlife text policy')
    if not isinstance(raw,bytes)or len(raw)>MAX_BYTES:raise CompileError('CSV exceeds10 MiB or is not byte input')
    try:
        reader=csv.reader(io.StringIO(raw.decode('utf-8-sig'),newline=''),strict=True)
        header=next(reader,None);columns=['id',*[f['name']for f in spec['fields']]]
        if (not isinstance(header,list)or len(set(header))!=len(header)or 'id'not in header
                or not set(header)<=set(columns)or (len(header)<2 if partial else set(header)!=set(columns))):
            raise CompileError('CSV needs id and distinct exact app fields; full import needs every column, patch needs at least one value column')
        definitions={f['name']:f for f in spec['fields']};records=[]
        for ordinal,row in enumerate(reader,1):
            if ordinal>MAX_RECORDS:raise CompileError('CSV exceeds10000 records')
            if len(row)!=len(header):raise CompileError(f'CSV record{ordinal} has missing or extra cells')
            result={}
            for name,value in zip(header,row):
                kind=definitions[name]['type']if name!='id'else'text'
                if kind=='integer':
                    if value=='':value=None
                    elif not re.fullmatch(r'-?(?:0|[1-9][0-9]*)',value)or len(value)>17:raise CompileError(f'CSV record{ordinal} field {name} needs an exact decimal integer or empty null')
                    else:value=int(value)
                elif kind=='boolean':
                    if value not in ('true','false'):raise CompileError(f'CSV record{ordinal} field {name} needs literal true or false')
                    value=value=='true'
                elif text_policy=='afterlife'and value:
                    if not value.startswith("'"):raise CompileError(f'CSV record{ordinal} field {name} lacks the explicit Afterlife text prefix')
                    value=value[1:]
                result[name]=value
            records.append(result)
    except (UnicodeError,csv.Error)as exc:raise CompileError('invalid UTF-8 CSV: '+str(exc))from exc
    return records


def normalized_backup(spec,records):
    envelope={'format':'afterlife-data/v1','app_id':spec['app_id'],'spec_fingerprint':_hash(_canonical(spec)),'records':records}
    envelope['records']=backup_records(spec,envelope)
    if len(_canonical(envelope).encode('utf-8'))+1>MAX_BYTES:raise CompileError('normalized CSV backup exceeds10 MiB')
    return envelope


def import_csv(spec,path,*,text_policy):
    spec=validate_spec(spec)
    return normalized_backup(spec,decode_csv_rows(spec,read_file(path,MAX_BYTES),text_policy=text_policy))
