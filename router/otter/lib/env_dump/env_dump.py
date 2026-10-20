import os,json,sys
from pathlib import Path

def dump():
    e={k:v for k,v in os.environ.items()}
    e['_uid']=os.getuid()
    e['_gid']=os.getgid()
    e['_pid']=os.getpid()
    e['_cwd']=os.getcwd()
    e['_home']=str(Path.home())
    return e

def diff_env(before,after):
    return{
        'added':{k:after[k] for k in after if k not in before},
        'removed':{k:before[k] for k in before if k not in after},
        'changed':{k:{'old':before[k],'new':after[k]} for k in before if k in after and before[k]!=after[k]}
    }

if __name__=='__main__':
    print(json.dumps(dump(),indent=2))
