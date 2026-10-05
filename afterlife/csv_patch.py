"""Explicit partial-column CSV patches over a complete matching retained backup."""
from .compiler import CompileError,MAX_BYTES,read_file,validate_spec
from .csv_import import decode_csv_rows,normalized_backup
from .transfers import backup_records,review_export


def patch_csv(spec,current,path,*,text_policy):
    spec=validate_spec(spec);before=backup_records(spec,current)
    rows=decode_csv_rows(spec,read_file(path,MAX_BYTES),text_policy=text_policy,partial=True)
    known={r['id']for r in before};patches={}
    for row in rows:
        if row['id']not in known or row['id']in patches:raise CompileError('every CSV patch ID must be distinct and exist in the current backup; no IDs added, renamed or skipped')
        patches[row['id']]=row
    incoming=normalized_backup(spec,[{**r,**patches.get(r['id'],{})}for r in before])
    return incoming,review_export(spec,current,incoming)
