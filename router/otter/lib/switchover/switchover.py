import os,sys,subprocess,time,json,signal
from pathlib import Path

def R(c,t=3):
    try:
        p=subprocess.run(c,shell=True,capture_output=True,text=True,timeout=t)
        return{'o':p.stdout,'e':p.stderr,'r':p.returncode}
    except Exception as e:
        return{'o':'','e':str(e),'r':-1}

def health(u='http://localhost:8888/health',t=2):
    return R(f'curl -s -m {t} {u}',t+1)

def restart(path='/app/kernel_server.py',port=8888,t=30):
    env=os.environ.copy()
    env['PYTHONUNBUFFERED']='1'
    log=Path('/tmp/kernel_restart.log')
    with open(log,'w') as f:
        p=subprocess.Popen(['python3',path,'--host','0.0.0.0','--port',str(port),'--log-level','info'],
            cwd='/mnt/agents',env=env,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
    for i in range(t):
        h=health()
        if 'kernel_alive' in h.get('o',''):
            return{'ok':True,'pid':p.pid}
        time.sleep(1)
    return{'ok':False,'pid':p.pid}

if __name__=='__main__':
    print(json.dumps(restart(),indent=2))
